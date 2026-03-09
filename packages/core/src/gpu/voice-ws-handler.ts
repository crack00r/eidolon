/**
 * Server-side WebSocket handler for real-time voice sessions.
 *
 * Handles binary (Opus audio) + JSON control messages from clients,
 * wires into the VoiceStateMachine, and dispatches STT/TTS requests
 * to the GPU worker pool.
 *
 * Protocol:
 *   Client -> Server:
 *     - Binary data: Opus audio frames for STT
 *     - JSON { type: "control", action: "start"|"stop"|"interrupt"|"config", config?: {...} }
 *   Server -> Client:
 *     - Binary data: TTS audio frames (Opus)
 *     - JSON { type: "transcript", text: string, final: boolean }
 *     - JSON { type: "state", state: VoiceMachineState }
 *     - JSON { type: "error", message: string }
 */

import type { Logger } from "../logging/logger.ts";
import type { GPUWorkerPool } from "./pool.ts";
import type { VoiceMachineState } from "./voice-state-machine.ts";
import { VoiceStateMachine } from "./voice-state-machine.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Abstraction over a WebSocket connection for testability. */
export interface VoiceWebSocket {
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

/** WebSocket readyState constants. */
const WS_OPEN = 1;

/** Server JSON messages. */
interface ServerTranscriptMessage {
  readonly type: "transcript";
  readonly text: string;
  readonly final: boolean;
}

interface ServerStateMessage {
  readonly type: "state";
  readonly state: VoiceMachineState;
}

interface ServerErrorMessage {
  readonly type: "error";
  readonly message: string;
}

export interface VoiceSessionConfig {
  /** Maximum audio buffer size in bytes before auto-flush for STT. Default: 1MB. */
  readonly maxAudioBufferBytes?: number;
  /** Locale for TTS sentence segmentation. Default: "en". */
  readonly locale?: string;
}

const DEFAULT_MAX_AUDIO_BUFFER = 1024 * 1024; // 1 MB
const MAX_CHUNK_SIZE = 64 * 1024; // 64 KB per individual chunk
const MAX_JSON_MESSAGE_SIZE = 64 * 1024; // 64 KB max JSON message size
/** Hard upper limit for total audio buffer to prevent memory DoS. */
const MAX_AUDIO_BUFFER_SIZE = 50 * 1024 * 1024; // 50 MB

// ---------------------------------------------------------------------------
// VoiceWsHandler
// ---------------------------------------------------------------------------

/**
 * Handles a single voice WebSocket session.
 * One instance per connected client.
 */
export class VoiceWsHandler {
  private readonly ws: VoiceWebSocket;
  private readonly pool: GPUWorkerPool;
  private readonly stateMachine: VoiceStateMachine;
  private readonly logger: Logger;
  private readonly config: Required<VoiceSessionConfig>;
  private audioBuffer: Uint8Array[] = [];
  private audioBufferSize = 0;
  private disposed = false;
  private flushing = false;

  constructor(ws: VoiceWebSocket, pool: GPUWorkerPool, logger: Logger, config?: VoiceSessionConfig) {
    this.ws = ws;
    this.pool = pool;
    this.logger = logger.child("voice-ws-handler");
    this.config = {
      maxAudioBufferBytes: config?.maxAudioBufferBytes ?? DEFAULT_MAX_AUDIO_BUFFER,
      locale: config?.locale ?? "en",
    };

    this.stateMachine = new VoiceStateMachine(logger);

    // Wire barge-in to flush audio and notify client
    this.stateMachine.onBargeIn(() => {
      this.audioBuffer = [];
      this.audioBufferSize = 0;
      this.logger.info("barge-in", "Barge-in: cleared audio buffer");
    });

    // Notify client of state changes
    this.stateMachine.onStateChange((transition) => {
      this.sendStateUpdate(transition.to);
    });
  }

  /** Get the underlying state machine (for testing). */
  get voiceState(): VoiceMachineState {
    return this.stateMachine.state;
  }

  /**
   * Handle an incoming WebSocket message (binary or text).
   * Call this from the WebSocket server's message handler.
   */
  async handleMessage(data: string | ArrayBuffer | Uint8Array): Promise<void> {
    if (this.disposed) return;

    // Binary data: audio frame
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      const chunk = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
      this.handleAudioChunk(chunk);
      return;
    }

    // Text data: JSON control message
    if (typeof data === "string") {
      if (data.length > MAX_JSON_MESSAGE_SIZE) {
        this.sendError(`JSON message too large (${data.length} bytes, max ${MAX_JSON_MESSAGE_SIZE})`);
        return;
      }
      this.handleJsonMessage(data);
      return;
    }
  }

  /** Handle connection close. */
  dispose(): void {
    this.disposed = true;
    this.audioBuffer = [];
    this.audioBufferSize = 0;
    this.stateMachine.reset();
    this.logger.info("dispose", "Voice session disposed");
  }

  // -------------------------------------------------------------------------
  // Private: Audio handling
  // -------------------------------------------------------------------------

  private handleAudioChunk(chunk: Uint8Array): void {
    // Reject oversized chunks to prevent memory abuse
    if (chunk.byteLength > MAX_CHUNK_SIZE) {
      this.sendError(`Audio chunk too large (${chunk.byteLength} bytes, max ${MAX_CHUNK_SIZE})`);
      return;
    }

    if (this.stateMachine.state !== "listening") {
      // Attempt to start listening if idle
      if (this.stateMachine.state === "idle") {
        this.stateMachine.transition("speech_start");
      } else {
        // Can't accept audio in processing/speaking states unless barge-in
        return;
      }
    }

    // Reject if total buffer would exceed hard limit (memory DoS protection)
    if (this.audioBufferSize + chunk.byteLength > MAX_AUDIO_BUFFER_SIZE) {
      this.logger.error("audio-buffer", `Audio buffer exceeded ${MAX_AUDIO_BUFFER_SIZE} bytes, closing connection`);
      this.sendError(`Audio buffer exceeded maximum size (${MAX_AUDIO_BUFFER_SIZE} bytes)`);
      this.ws.close(1009, "Audio buffer too large");
      return;
    }

    this.audioBuffer.push(chunk);
    this.audioBufferSize += chunk.byteLength;

    // Auto-flush if buffer is too large
    if (this.audioBufferSize >= this.config.maxAudioBufferBytes) {
      this.flushAudioForStt().catch((err: unknown) => {
        this.logger.error("flush-error", "Unhandled error during auto-flush STT", err);
      });
    }
  }

  private async flushAudioForStt(): Promise<void> {
    if (this.flushing) return;
    if (this.audioBuffer.length === 0) return;

    this.flushing = true;
    try {
      // Concatenate audio chunks
      const totalSize = this.audioBufferSize;
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of this.audioBuffer) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
      }

      this.audioBuffer = [];
      this.audioBufferSize = 0;

      // Transition to processing
      this.stateMachine.transition("speech_end");

      // Send to STT
      const sttResult = await this.pool.stt(combined, "audio/opus");

      if (this.disposed) return;

      // If barge-in occurred during STT, skip the processing_complete transition
      if (this.stateMachine.state !== "processing") return;

      if (sttResult.ok) {
        const msg: ServerTranscriptMessage = {
          type: "transcript",
          text: sttResult.value.text,
          final: true,
        };
        this.sendJson(msg);

        // After STT completes, transition to idle (processing complete)
        this.stateMachine.transition("processing_complete");
      } else {
        this.sendError(`STT failed: ${sttResult.error.message}`);
        this.stateMachine.transition("processing_complete");
      }
    } finally {
      this.flushing = false;
    }
  }

  // -------------------------------------------------------------------------
  // Private: JSON message handling
  // -------------------------------------------------------------------------

  private handleJsonMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.sendError("Invalid JSON");
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.sendError("Message must be a JSON object");
      return;
    }

    const msg = parsed as Record<string, unknown>;
    const msgType = typeof msg.type === "string" ? msg.type : "";

    if (msgType === "control") {
      this.handleControlMessage(msg);
    } else if (msgType === "ping") {
      this.sendJson({ type: "pong" });
    } else {
      this.sendError(`Unknown message type: ${msgType}`);
    }
  }

  private handleControlMessage(msg: Record<string, unknown>): void {
    const action = typeof msg.action === "string" ? msg.action : "";

    switch (action) {
      case "start":
        this.stateMachine.transition("speech_start");
        break;

      case "stop":
        this.flushAudioForStt().catch((err: unknown) => {
          this.logger.error("flush-error", "Unhandled error during stop-flush STT", err);
        });
        break;

      case "interrupt":
        this.stateMachine.bargeIn();
        break;

      case "config":
        // Config updates are acknowledged but don't change state
        this.logger.debug("config", "Client config update received");
        break;

      default:
        this.sendError(`Unknown control action: ${action}`);
    }
  }

  // -------------------------------------------------------------------------
  // Private: Send helpers
  // -------------------------------------------------------------------------

  private sendJson(data: ServerTranscriptMessage | ServerStateMessage | ServerErrorMessage | { type: "pong" }): void {
    if (this.disposed || this.ws.readyState !== WS_OPEN) return;

    try {
      this.ws.send(JSON.stringify(data));
    } catch (err: unknown) {
      this.logger.error("send-error", "Failed to send JSON to client", err);
    }
  }

  private sendStateUpdate(state: VoiceMachineState): void {
    const msg: ServerStateMessage = { type: "state", state };
    this.sendJson(msg);
  }

  private sendError(message: string): void {
    const msg: ServerErrorMessage = { type: "error", message };
    this.sendJson(msg);
    this.logger.warn("client-error", message);
  }

  /** Send binary audio data to the client (TTS output). */
  sendAudio(data: Uint8Array): void {
    if (this.disposed || this.ws.readyState !== WS_OPEN) return;

    try {
      this.ws.send(data);
    } catch (err: unknown) {
      this.logger.error("send-error", "Failed to send audio to client", err);
    }
  }
}
