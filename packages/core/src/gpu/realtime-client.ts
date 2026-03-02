/**
 * Real-time voice WebSocket client for the GPU worker.
 *
 * Connects to WS /voice/realtime on the GPU worker and provides:
 * - Bidirectional audio streaming (Opus frames)
 * - STT transcription callbacks
 * - TTS request/response via the same WebSocket
 * - Automatic reconnection with exponential backoff
 * - Ping/pong keep-alive (30-second interval)
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback invoked when a transcription result arrives from the GPU worker. */
export type TranscriptionCallback = (text: string, isFinal: boolean) => void;

/** Callback invoked when TTS audio data arrives from the GPU worker. */
export type AudioCallback = (chunk: Uint8Array) => void;

/** Callback invoked when an error occurs on the WebSocket connection. */
export type ErrorCallback = (error: Error) => void;

/**
 * Server-to-client JSON message types (documentation):
 * - { type: "transcript", text: string, final: boolean } — STT result
 * - { type: "state", state: string }                     — voice state update
 * - { type: "error", message: string }                   — server error
 * - { type: "pong" }                                     — keep-alive response
 */

/** Configuration for the realtime voice client. */
export interface RealtimeClientConfig {
  /** Ping interval in ms (default: 30_000). */
  readonly pingIntervalMs?: number;
  /** Maximum reconnection attempts (default: 5). */
  readonly maxReconnectAttempts?: number;
  /** Base delay for exponential backoff in ms (default: 1_000). */
  readonly reconnectBaseDelayMs?: number;
  /** Maximum backoff delay in ms (default: 30_000). */
  readonly reconnectMaxDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30_000;

// ---------------------------------------------------------------------------
// RealtimeVoiceClient
// ---------------------------------------------------------------------------

export class RealtimeVoiceClient {
  private readonly logger: Logger;
  private readonly config: Required<RealtimeClientConfig>;

  private ws: WebSocket | null = null;
  private url = "";
  private token = "";

  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  private transcriptionCallbacks: TranscriptionCallback[] = [];
  private audioCallbacks: AudioCallback[] = [];
  private errorCallbacks: ErrorCallback[] = [];

  constructor(logger: Logger, config?: RealtimeClientConfig) {
    this.logger = logger.child("realtime-voice");
    this.config = {
      pingIntervalMs: config?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
      maxReconnectAttempts: config?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      reconnectBaseDelayMs: config?.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS,
      reconnectMaxDelayMs: config?.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
    };
  }

  /**
   * Open a WebSocket connection to the GPU worker's real-time voice endpoint.
   *
   * @param url - Base URL of the GPU worker (e.g. "ws://192.168.1.10:8420")
   * @param authToken - Pre-shared API key for authentication
   */
  async connect(url: string, authToken: string): Promise<Result<void, EidolonError>> {
    if (this.ws !== null) {
      return Err(createError(ErrorCode.GPU_UNAVAILABLE, "Already connected — disconnect first"));
    }

    this.url = url;
    this.token = authToken;
    this.intentionalClose = false;
    this.reconnectAttempts = 0;

    return this.openConnection();
  }

  /**
   * Close the WebSocket connection cleanly.
   */
  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    this.stopPing();
    this.clearReconnectTimer();

    if (this.ws !== null) {
      try {
        this.ws.close(1000, "Client disconnect");
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.logger.info("disconnect", "Realtime voice client disconnected");
  }

  /**
   * Send an audio chunk (Opus-encoded) to the GPU worker for STT.
   */
  sendAudio(chunk: Uint8Array): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      this.notifyError(new Error("WebSocket is not connected"));
      return;
    }

    try {
      this.ws.send(chunk);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.notifyError(new Error(`Failed to send audio: ${message}`));
    }
  }

  /**
   * Request TTS synthesis via the WebSocket.
   *
   * @param text - Text to synthesize
   * @param voice - Optional voice name (default: "default")
   */
  requestTts(text: string, voice?: string): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) {
      this.notifyError(new Error("WebSocket is not connected"));
      return;
    }

    const payload = JSON.stringify({
      type: "tts",
      text,
      voice: voice ?? "default",
    });

    try {
      this.ws.send(payload);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.notifyError(new Error(`Failed to send TTS request: ${message}`));
    }
  }

  /**
   * Register a callback for STT transcription results.
   */
  onTranscription(callback: TranscriptionCallback): void {
    this.transcriptionCallbacks.push(callback);
  }

  /**
   * Register a callback for TTS audio data.
   */
  onAudio(callback: AudioCallback): void {
    this.audioCallbacks.push(callback);
  }

  /**
   * Register a callback for errors.
   */
  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  /**
   * Check if the WebSocket is currently connected and open.
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Private: Connection management
  // ---------------------------------------------------------------------------

  private async openConnection(): Promise<Result<void, EidolonError>> {
    return new Promise<Result<void, EidolonError>>((resolve) => {
      try {
        const wsUrl = this.buildWsUrl(this.url, this.token);
        const socket = new WebSocket(wsUrl);
        socket.binaryType = "arraybuffer";

        let resolved = false;

        socket.onopen = (): void => {
          this.ws = socket;
          this.reconnectAttempts = 0;
          this.startPing();
          this.logger.info("connect", "Realtime voice WebSocket connected", { url: this.url });

          if (!resolved) {
            resolved = true;
            resolve(Ok(undefined));
          }
        };

        socket.onmessage = (event: MessageEvent): void => {
          this.handleMessage(event);
        };

        socket.onerror = (event: Event): void => {
          const errorMessage =
            "error" in event && typeof (event as Record<string, unknown>).error === "string"
              ? String((event as Record<string, unknown>).error)
              : "WebSocket error";
          this.logger.error("ws-error", errorMessage);
          this.notifyError(new Error(errorMessage));

          if (!resolved) {
            resolved = true;
            resolve(Err(createError(ErrorCode.GPU_UNAVAILABLE, `WebSocket connection failed: ${errorMessage}`)));
          }
        };

        socket.onclose = (event: CloseEvent): void => {
          this.logger.info("ws-close", "WebSocket closed", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });

          this.ws = null;
          this.stopPing();

          if (!resolved) {
            resolved = true;
            resolve(
              Err(
                createError(
                  ErrorCode.GPU_UNAVAILABLE,
                  `WebSocket closed before open: code=${event.code} reason=${event.reason}`,
                ),
              ),
            );
          }

          // Attempt reconnection if not intentional
          if (!this.intentionalClose) {
            this.scheduleReconnect();
          }
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        resolve(Err(createError(ErrorCode.GPU_UNAVAILABLE, `Failed to create WebSocket: ${message}`, err)));
      }
    });
  }

  private buildWsUrl(baseUrl: string, authToken: string): string {
    // Convert http(s) to ws(s) if needed
    let wsBase = baseUrl;
    if (wsBase.startsWith("http://")) {
      wsBase = `ws://${wsBase.slice(7)}`;
    } else if (wsBase.startsWith("https://")) {
      wsBase = `wss://${wsBase.slice(8)}`;
    } else if (!wsBase.startsWith("ws://") && !wsBase.startsWith("wss://")) {
      wsBase = `ws://${wsBase}`;
    }

    // Remove trailing slash
    if (wsBase.endsWith("/")) {
      wsBase = wsBase.slice(0, -1);
    }

    return `${wsBase}/voice/realtime?token=${encodeURIComponent(authToken)}`;
  }

  private handleMessage(event: MessageEvent): void {
    // Binary message: TTS audio chunk
    if (event.data instanceof ArrayBuffer) {
      const chunk = new Uint8Array(event.data);
      for (const cb of this.audioCallbacks) {
        try {
          cb(chunk);
        } catch (err: unknown) {
          this.logger.error("callback-error", "Audio callback threw", err);
        }
      }
      return;
    }

    // Text message: JSON
    if (typeof event.data === "string") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        this.logger.warn("parse-error", "Failed to parse server JSON message", { raw: event.data });
        return;
      }

      if (typeof parsed !== "object" || parsed === null) {
        this.logger.warn("parse-error", "Server message is not a JSON object");
        return;
      }

      const msg = parsed as Record<string, unknown>;
      const msgType = typeof msg.type === "string" ? msg.type : "";

      this.dispatchJsonMessage(msgType, msg);
      return;
    }

    this.logger.warn("unknown-message", "Received unknown message type from server");
  }

  private dispatchJsonMessage(msgType: string, msg: Record<string, unknown>): void {
    switch (msgType) {
      case "transcript": {
        const text = typeof msg.text === "string" ? msg.text : "";
        const isFinal = typeof msg.final === "boolean" ? msg.final : true;
        for (const cb of this.transcriptionCallbacks) {
          try {
            cb(text, isFinal);
          } catch (err: unknown) {
            this.logger.error("callback-error", "Transcription callback threw", err);
          }
        }
        break;
      }

      case "state": {
        const state = typeof msg.state === "string" ? msg.state : "unknown";
        this.logger.debug("state-change", "Server voice state changed", { state });
        break;
      }

      case "error": {
        const errorMsg = typeof msg.message === "string" ? msg.message : "Unknown server error";
        this.logger.warn("server-error", `Server error: ${errorMsg}`);
        this.notifyError(new Error(`Server: ${errorMsg}`));
        break;
      }

      case "pong": {
        this.logger.debug("pong", "Received pong from server");
        break;
      }

      default: {
        this.logger.debug("unknown-type", `Unknown server message type: ${msgType}`);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Ping/pong keep-alive
  // ---------------------------------------------------------------------------

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          // Connection may be closing
        }
      }
    }, this.config.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Reconnection with exponential backoff
  // ---------------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      this.logger.warn("reconnect", "Max reconnection attempts reached", {
        attempts: this.reconnectAttempts,
        max: this.config.maxReconnectAttempts,
      });
      this.notifyError(new Error(`Max reconnection attempts (${this.config.maxReconnectAttempts}) reached`));
      return;
    }

    const delay = Math.min(
      this.config.reconnectBaseDelayMs * 2 ** this.reconnectAttempts,
      this.config.reconnectMaxDelayMs,
    );

    this.reconnectAttempts += 1;

    this.logger.info("reconnect", `Scheduling reconnect attempt ${this.reconnectAttempts}`, {
      delayMs: delay,
    });

    // ERR-002: Properly handle reconnect promise to prevent unhandled rejections
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openConnection()
        .then((result) => {
          if (!result.ok) {
            this.logger.warn("reconnect", `Reconnect attempt ${this.reconnectAttempts} failed`, {
              error: result.error.message,
            });
          }
        })
        .catch((err: unknown) => {
          this.logger.error("reconnect", "Reconnect attempt threw unexpected error", err);
          this.notifyError(err instanceof Error ? err : new Error(String(err)));
        });
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: Error notification
  // ---------------------------------------------------------------------------

  private notifyError(error: Error): void {
    for (const cb of this.errorCallbacks) {
      try {
        cb(error);
      } catch (err: unknown) {
        this.logger.error("callback-error", "Error callback threw", err);
      }
    }
  }
}
