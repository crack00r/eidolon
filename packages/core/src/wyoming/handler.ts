/**
 * Wyoming event handler -- processes satellite voice interactions.
 *
 * Receives audio from satellites, runs STT via GPUManager,
 * processes the text through the EventBus (Cognitive Loop),
 * then synthesizes a TTS response and sends it back.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { STTClient } from "../gpu/stt-client.ts";
import type { TTSClient } from "../gpu/tts-client.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import {
  AudioChunkDataSchema,
  AudioStartDataSchema,
  SynthesizeDataSchema,
  serializeEvent,
  type WyomingEvent,
} from "./protocol.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback to write bytes back to the satellite TCP socket. */
export type SocketWriter = (data: Uint8Array) => void;

/** Callback invoked when the EventBus produces a response for the satellite. */
export type ResponseCallback = (text: string) => Promise<void>;

export interface WyomingHandlerDeps {
  readonly stt: STTClient;
  readonly tts: TTSClient;
  readonly eventBus: EventBus;
  readonly logger: Logger;
}

interface AudioSession {
  rate: number;
  width: number;
  channels: number;
  chunks: Uint8Array[];
  totalBytes: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum audio session size: 25 MB (matches STT client limit). */
const MAX_AUDIO_SESSION_BYTES = 25 * 1024 * 1024;

/** Maximum text length for TTS synthesis in response. */
const MAX_RESPONSE_TEXT_LENGTH = 10_000;

// ---------------------------------------------------------------------------
// WyomingHandler
// ---------------------------------------------------------------------------

export class WyomingHandler {
  private readonly stt: STTClient;
  private readonly tts: TTSClient;
  private readonly eventBus: EventBus;
  private readonly logger: Logger;

  /** Active audio sessions keyed by satellite ID to isolate concurrent satellites. */
  private readonly audioSessions: Map<string, AudioSession> = new Map();

  constructor(deps: WyomingHandlerDeps) {
    this.stt = deps.stt;
    this.tts = deps.tts;
    this.eventBus = deps.eventBus;
    this.logger = deps.logger.child("wyoming-handler");
  }

  /**
   * Handle a Wyoming event from a satellite.
   * Returns serialized response events to send back, or empty array if none.
   */
  async handleEvent(event: WyomingEvent, satelliteId: string): Promise<Result<readonly Uint8Array[], EidolonError>> {
    switch (event.type) {
      case "describe":
        return this.handleDescribe();
      case "audio-start":
        return this.handleAudioStart(event, satelliteId);
      case "audio-chunk":
        return this.handleAudioChunk(event, satelliteId);
      case "audio-stop":
        return this.handleAudioStop(satelliteId);
      case "synthesize":
        return this.handleSynthesize(event, satelliteId);
      case "ping":
        return Ok([serializeEvent({ type: "pong", data: {}, payload: null })]);
      default:
        this.logger.debug("handleEvent", `Unhandled Wyoming event type: ${event.type}`, {
          satelliteId,
        });
        return Ok([]);
    }
  }

  /** Respond to a `describe` event with server capabilities. */
  private handleDescribe(): Result<readonly Uint8Array[], EidolonError> {
    const infoEvent: WyomingEvent = {
      type: "info",
      data: {
        asr: [
          {
            name: "eidolon-stt",
            description: "Eidolon STT via GPU worker (faster-whisper)",
            installed: true,
            languages: ["en", "de", "fr", "es", "it", "pt", "nl", "ja", "ko", "zh"],
          },
        ],
        tts: [
          {
            name: "eidolon-tts",
            description: "Eidolon TTS via GPU worker (Qwen3-TTS)",
            installed: true,
            languages: ["en", "de", "fr", "es", "it", "pt", "nl", "ja", "ko", "zh"],
          },
        ],
        intent: [
          {
            name: "eidolon-intent",
            description: "Eidolon intent processing via Claude",
            installed: true,
            languages: ["en", "de"],
          },
        ],
      },
      payload: null,
    };

    return Ok([serializeEvent(infoEvent)]);
  }

  /** Start a new audio recording session. */
  private handleAudioStart(event: WyomingEvent, satelliteId: string): Result<readonly Uint8Array[], EidolonError> {
    const parseResult = AudioStartDataSchema.safeParse(event.data);
    if (!parseResult.success) {
      return Err(
        createError(ErrorCode.WYOMING_PROTOCOL_ERROR, `Invalid audio-start data: ${parseResult.error.message}`),
      );
    }

    this.audioSessions.set(satelliteId, {
      rate: parseResult.data.rate,
      width: parseResult.data.width,
      channels: parseResult.data.channels,
      chunks: [],
      totalBytes: 0,
    });

    this.logger.debug("handleAudioStart", "Audio session started", {
      satelliteId,
      rate: parseResult.data.rate,
      width: parseResult.data.width,
      channels: parseResult.data.channels,
    });

    return Ok([]);
  }

  /** Append an audio chunk to the current session. */
  private handleAudioChunk(event: WyomingEvent, satelliteId: string): Result<readonly Uint8Array[], EidolonError> {
    const session = this.audioSessions.get(satelliteId);
    if (!session) {
      return Err(createError(ErrorCode.WYOMING_PROTOCOL_ERROR, "Received audio-chunk without audio-start"));
    }

    // Validate chunk data header (optional, but good practice)
    AudioChunkDataSchema.safeParse(event.data);

    if (event.payload === null || event.payload.byteLength === 0) {
      return Ok([]);
    }

    const newTotal = session.totalBytes + event.payload.byteLength;
    if (newTotal > MAX_AUDIO_SESSION_BYTES) {
      this.audioSessions.delete(satelliteId);
      return Err(createError(ErrorCode.WYOMING_PROTOCOL_ERROR, `Audio session too large: ${newTotal} bytes`));
    }

    session.chunks.push(event.payload);
    session.totalBytes = newTotal;

    return Ok([]);
  }

  /** Finalize audio recording, run STT, publish to EventBus, run TTS, return response audio. */
  private async handleAudioStop(satelliteId: string): Promise<Result<readonly Uint8Array[], EidolonError>> {
    const session = this.audioSessions.get(satelliteId);
    if (!session) {
      return Err(createError(ErrorCode.WYOMING_PROTOCOL_ERROR, "Received audio-stop without audio-start"));
    }

    this.audioSessions.delete(satelliteId);

    if (session.totalBytes === 0) {
      return Ok([]);
    }

    // Concatenate audio chunks (raw PCM)
    const rawPcm = concatChunks(session.chunks, session.totalBytes);

    // Wrap raw PCM in a WAV container so the STT service receives valid audio/wav
    const audioData = wrapPcmInWav(rawPcm, session.rate, session.channels, session.width);

    this.logger.info("handleAudioStop", "Processing audio from satellite", {
      satelliteId,
      audioBytes: audioData.byteLength,
      rate: session.rate,
    });

    // STT: audio -> text
    const sttResult = await this.stt.transcribe(audioData, "audio/wav");
    if (!sttResult.ok) {
      return Err(createError(ErrorCode.WYOMING_HANDLER_FAILED, `STT failed: ${sttResult.error.message}`));
    }

    const transcript = sttResult.value.text;
    if (transcript.trim().length === 0) {
      return Ok([]);
    }

    // Send transcript event back to satellite
    const transcriptEvent = serializeEvent({
      type: "transcript",
      data: { text: transcript },
      payload: null,
    });

    // Publish to EventBus for cognitive loop processing
    this.eventBus.publish(
      "user:message",
      {
        channelId: `wyoming:${satelliteId}`,
        userId: satelliteId,
        text: transcript,
      },
      { priority: "high", source: `wyoming:${satelliteId}` },
    );

    this.logger.info("handleAudioStop", "STT completed, published to EventBus", {
      satelliteId,
      transcript: transcript.slice(0, 100),
    });

    return Ok([transcriptEvent]);
  }

  /** Handle a synthesize request: run TTS and return audio events. */
  private async handleSynthesize(
    event: WyomingEvent,
    satelliteId: string,
  ): Promise<Result<readonly Uint8Array[], EidolonError>> {
    const parseResult = SynthesizeDataSchema.safeParse(event.data);
    if (!parseResult.success) {
      return Err(
        createError(ErrorCode.WYOMING_PROTOCOL_ERROR, `Invalid synthesize data: ${parseResult.error.message}`),
      );
    }

    const text = parseResult.data.text.slice(0, MAX_RESPONSE_TEXT_LENGTH);

    this.logger.debug("handleSynthesize", "Synthesizing TTS response", {
      satelliteId,
      textLength: text.length,
    });

    const ttsResult = await this.tts.synthesize({
      text,
      voice: parseResult.data.voice,
      format: "wav",
    });

    if (!ttsResult.ok) {
      const errorEvent = serializeEvent({
        type: "error",
        data: { text: `TTS failed: ${ttsResult.error.message}` },
        payload: null,
      });
      return Ok([errorEvent]);
    }

    // Send audio-start, audio-chunk (with payload), audio-stop
    const responses: Uint8Array[] = [];

    responses.push(
      serializeEvent({
        type: "audio-start",
        data: { rate: 22_050, width: 2, channels: 1 },
        payload: null,
      }),
    );

    responses.push(
      serializeEvent({
        type: "audio-chunk",
        data: { rate: 22_050, width: 2, channels: 1 },
        payload: ttsResult.value.audio,
      }),
    );

    responses.push(
      serializeEvent({
        type: "audio-stop",
        data: {},
        payload: null,
      }),
    );

    this.logger.info("handleSynthesize", "TTS response sent", {
      satelliteId,
      audioBytes: ttsResult.value.audio.byteLength,
    });

    return Ok(responses);
  }

  /** Reset handler state (e.g., on disconnect). */
  reset(): void {
    this.audioSessions.clear();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function concatChunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) {
    const single = chunks[0];
    if (single !== undefined) return single;
  }
  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Prepend a standard 44-byte WAV header to raw PCM data. */
function wrapPcmInWav(pcm: Uint8Array, sampleRate: number, channels: number, bytesPerSample: number): Uint8Array {
  const dataSize = pcm.byteLength;
  const headerSize = 44;
  const wav = new Uint8Array(headerSize + dataSize);
  const view = new DataView(wav.buffer);

  // RIFF header
  wav.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + dataSize, true); // File size - 8
  wav.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"

  // fmt sub-chunk
  wav.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true); // Sub-chunk size (16 for PCM)
  view.setUint16(20, 1, true); // Audio format (1 = PCM)
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // Byte rate
  view.setUint16(32, channels * bytesPerSample, true); // Block align
  view.setUint16(34, bytesPerSample * 8, true); // Bits per sample

  // data sub-chunk
  wav.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, dataSize, true);

  // PCM data
  wav.set(pcm, headerSize);

  return wav;
}
