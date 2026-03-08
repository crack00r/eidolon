/**
 * TTS client — HTTP client for the GPU worker's POST /tts/synthesize endpoint.
 *
 * Sends text and receives synthesized audio bytes.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { GPUManager } from "./manager.ts";
import {
  MAX_TTS_SPEED,
  MAX_TTS_TEXT_LENGTH,
  MAX_VOICE_LENGTH,
  MIN_TTS_SPEED,
  VALID_TTS_FORMATS,
  VOICE_PATTERN,
} from "./pool-validation.ts";

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

    // Validate TTS text length
    if (request.text.length === 0) {
      return Err(createError(ErrorCode.TTS_FAILED, "TTS text is empty"));
    }

    if (request.text.length > MAX_TTS_TEXT_LENGTH) {
      return Err(
        createError(
          ErrorCode.TTS_FAILED,
          `TTS text too long: ${request.text.length} characters (max ${MAX_TTS_TEXT_LENGTH})`,
        ),
      );
    }

    // Validate speed range
    if (request.speed !== undefined && (request.speed < MIN_TTS_SPEED || request.speed > MAX_TTS_SPEED)) {
      return Err(
        createError(
          ErrorCode.TTS_FAILED,
          `TTS speed out of range: ${request.speed} (must be ${MIN_TTS_SPEED}-${MAX_TTS_SPEED})`,
        ),
      );
    }

    // Validate format
    if (request.format !== undefined && !VALID_TTS_FORMATS.has(request.format)) {
      return Err(createError(ErrorCode.TTS_FAILED, `Invalid TTS format: ${request.format}`));
    }

    // Validate voice parameter: length + safe characters only
    if (request.voice !== undefined) {
      if (request.voice.length === 0 || request.voice.length > MAX_VOICE_LENGTH) {
        return Err(
          createError(
            ErrorCode.TTS_FAILED,
            `Invalid TTS voice length: ${request.voice.length} (must be 1-${MAX_VOICE_LENGTH})`,
          ),
        );
      }
      if (!VOICE_PATTERN.test(request.voice)) {
        return Err(
          createError(
            ErrorCode.TTS_FAILED,
            "Invalid TTS voice: contains disallowed characters (only alphanumeric, hyphens, underscores, dots allowed)",
          ),
        );
      }
    }

    const startMs = Date.now();
    const body = JSON.stringify({
      text: request.text,
      voice: request.voice,
      speed: request.speed,
      format: request.format ?? "opus",
    });

    // Use GPUManager.request() to ensure authenticated requests
    const result = await this.gpu.request<ArrayBuffer>("/tts/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!result.ok) {
      return Err(createError(ErrorCode.TTS_FAILED, `TTS synthesis failed: ${result.error.message}`));
    }

    const audio = new Uint8Array(result.value);
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
  }

  /** Check if TTS is available via the GPU worker. */
  async isAvailable(): Promise<boolean> {
    const health = await this.gpu.checkHealth();
    if (!health.ok) return false;
    return health.value.modelsLoaded.some((m) => m.toLowerCase().includes("tts"));
  }
}
