/**
 * Streaming voice pipeline — sentence-level TTS chunking and STT passthrough.
 *
 * Splits long text into sentences using Intl.Segmenter, synthesizes each
 * chunk independently, and supports interruption mid-stream.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { STTClient } from "./stt-client.ts";
import type { TTSClient } from "./tts-client.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceState = "idle" | "listening" | "processing" | "speaking" | "interrupted";

// ---------------------------------------------------------------------------
// VoicePipeline
// ---------------------------------------------------------------------------

export class VoicePipeline {
  private readonly tts: TTSClient;
  private readonly stt: STTClient;
  private readonly logger: Logger;
  private currentState: VoiceState = "idle";

  /**
   * AbortController for the currently active TTS operation.
   * Each call to textToSpeechChunked creates a new controller,
   * ensuring interrupt() only affects the current operation and
   * avoids shared mutable state across concurrent calls.
   */
  private activeAbort: AbortController | null = null;

  constructor(ttsClient: TTSClient, sttClient: STTClient, logger: Logger) {
    this.tts = ttsClient;
    this.stt = sttClient;
    this.logger = logger.child("voice-pipeline");
  }

  /** Get current voice state. */
  get state(): VoiceState {
    return this.currentState;
  }

  /**
   * Process text response: split into sentences, TTS each, return audio chunks.
   * Returns an array of audio buffers, one per sentence.
   * Each call gets its own AbortSignal, preventing shared mutable state issues.
   */
  async textToSpeechChunked(text: string): Promise<Result<Uint8Array[], EidolonError>> {
    const sentences = VoicePipeline.splitSentences(text);
    if (sentences.length === 0) {
      return Ok([]);
    }

    const abort = new AbortController();
    this.activeAbort = abort;
    this.currentState = "processing";
    const chunks: Uint8Array[] = [];

    this.logger.debug("tts-chunked", "Starting chunked TTS", {
      sentenceCount: sentences.length,
      totalLength: text.length,
    });

    try {
      for (const sentence of sentences) {
        if (abort.signal.aborted) {
          this.currentState = "interrupted";
          this.logger.info("tts-chunked", "TTS interrupted", {
            completedChunks: chunks.length,
            totalSentences: sentences.length,
          });
          return Ok(chunks);
        }

        const result = await this.tts.synthesize({ text: sentence });

        if (!result.ok) {
          this.currentState = "idle";
          return Err(
            createError(ErrorCode.TTS_FAILED, `TTS failed on sentence: ${result.error.message}`, result.error),
          );
        }

        chunks.push(result.value.audio);
        this.currentState = "speaking";
      }

      this.currentState = "idle";
      return Ok(chunks);
    } finally {
      if (this.activeAbort === abort) {
        this.activeAbort = null;
      }
    }
  }

  /** Transcribe audio input. */
  async speechToText(audio: Uint8Array): Promise<Result<string, EidolonError>> {
    this.currentState = "listening";

    const result = await this.stt.transcribe(audio);

    this.currentState = "idle";

    if (!result.ok) {
      return Err(result.error);
    }

    return Ok(result.value.text);
  }

  /**
   * Split text into sentences using Intl.Segmenter.
   * Falls back to simple split on `. ` if Intl.Segmenter is unavailable.
   */
  static splitSentences(text: string): string[] {
    if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
      const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
      return [...segmenter.segment(text)].map((s) => s.segment.trim()).filter((s) => s.length > 0);
    }

    // Fallback for environments without Intl.Segmenter
    return text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  /** Interrupt current speech processing by aborting the active AbortController. */
  interrupt(): void {
    if (this.activeAbort) {
      this.activeAbort.abort();
    }
    this.currentState = "interrupted";
    this.logger.info("interrupt", "Voice pipeline interrupted");
  }
}
