/**
 * TTS client — HTTP client for the GPU worker's POST /tts/synthesize endpoint.
 *
 * Sends text and receives synthesized audio bytes.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";
import type { GPUManager } from "./manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TtsRequest {
  readonly text: string;
  readonly voice?: string;
  readonly speed?: number;
  readonly format?: "opus" | "wav" | "mp3";
}

export interface TtsResult {
  readonly audio: Uint8Array;
  readonly format: string;
  readonly durationMs: number;
}

// ---------------------------------------------------------------------------
// TTSClient
// ---------------------------------------------------------------------------

export class TTSClient {
  private readonly gpu: GPUManager;
  private readonly logger: Logger;

  constructor(gpuManager: GPUManager, logger: Logger) {
    this.gpu = gpuManager;
    this.logger = logger.child("tts-client");
  }

  /** Synthesize text to speech. */
  async synthesize(request: TtsRequest): Promise<Result<TtsResult, EidolonError>> {
    if (!this.gpu.isAvailable) {
      return Err(createError(ErrorCode.GPU_UNAVAILABLE, "GPU worker is not available for TTS"));
    }

    const startMs = Date.now();
    const body = JSON.stringify({
      text: request.text,
      voice: request.voice,
      speed: request.speed,
      format: request.format ?? "opus",
    });

    try {
      const response = await fetch(`${this.gpu.baseUrl}/tts/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return Err(createError(ErrorCode.TTS_FAILED, `TTS synthesis failed (${response.status}): ${errorText}`));
      }

      const audioBuffer = await response.arrayBuffer();
      const audio = new Uint8Array(audioBuffer);
      const durationMs = Date.now() - startMs;

      this.logger.debug("synthesize", "TTS completed", {
        textLength: request.text.length,
        audioBytes: audio.byteLength,
        durationMs,
      });

      return Ok({
        audio,
        format: request.format ?? "opus",
        durationMs,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.TTS_FAILED, `TTS synthesis request failed: ${message}`, err));
    }
  }

  /** Check if TTS is available via the GPU worker. */
  async isAvailable(): Promise<boolean> {
    const health = await this.gpu.checkHealth();
    if (!health.ok) return false;
    return health.value.modelsLoaded.some((m) => m.toLowerCase().includes("tts"));
  }
}
