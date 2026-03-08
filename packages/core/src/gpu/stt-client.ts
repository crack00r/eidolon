/**
 * STT client — HTTP client for the GPU worker's POST /stt/transcribe endpoint.
 *
 * Sends audio bytes and receives transcribed text.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { GPUManager } from "./manager.ts";
import {
  ALLOWED_STT_MIME_TYPES,
  MAX_STT_AUDIO_BYTES,
  STT_UPLOAD_TIMEOUT_MS,
} from "./pool-validation.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SttResult {
  readonly text: string;
  readonly language: string;
  readonly confidence: number;
  readonly durationSeconds: number;
}

// ---------------------------------------------------------------------------
// STTClient
// ---------------------------------------------------------------------------

export class STTClient {
  private readonly gpu: GPUManager;
  private readonly logger: Logger;

  constructor(gpuManager: GPUManager, logger: Logger) {
    this.gpu = gpuManager;
    this.logger = logger.child("stt-client");
  }

  /** Transcribe audio to text. */
  async transcribe(audio: Uint8Array, mimeType?: string): Promise<Result<SttResult, EidolonError>> {
    if (!this.gpu.isAvailable) {
      return Err(createError(ErrorCode.GPU_UNAVAILABLE, "GPU worker is not available for STT"));
    }

    // Validate audio size
    if (audio.byteLength > MAX_STT_AUDIO_BYTES) {
      return Err(
        createError(
          ErrorCode.STT_FAILED,
          `STT audio too large: ${audio.byteLength} bytes (max ${MAX_STT_AUDIO_BYTES})`,
        ),
      );
    }

    if (audio.byteLength === 0) {
      return Err(createError(ErrorCode.STT_FAILED, "STT audio is empty"));
    }

    const mime = mimeType ?? "audio/wav";

    // Validate MIME type
    if (!ALLOWED_STT_MIME_TYPES.has(mime)) {
      return Err(createError(ErrorCode.STT_FAILED, `Unsupported audio MIME type: ${mime}`));
    }

    const extension = mime.split("/")[1] ?? "wav";

    const formData = new FormData();
    const blob = new Blob([audio], { type: mime });
    formData.append("file", blob, `audio.${extension}`);

    // Use GPUManager.request() with explicit STT upload timeout (60s)
    const result = await this.gpu.request<SttResult>(
      "/stt/transcribe",
      {
        method: "POST",
        body: formData,
      },
      STT_UPLOAD_TIMEOUT_MS,
    );

    if (!result.ok) {
      return Err(createError(ErrorCode.STT_FAILED, `STT transcription failed: ${result.error.message}`));
    }

    this.logger.debug("transcribe", "STT completed", {
      textLength: result.value.text.length,
      language: result.value.language,
      confidence: result.value.confidence,
    });

    return Ok(result.value);
  }

  /** Check if STT is available via the GPU worker. */
  async isAvailable(): Promise<boolean> {
    const health = await this.gpu.checkHealth();
    if (!health.ok) return false;
    return health.value.modelsLoaded.some(
      (m) => m.toLowerCase().includes("whisper") || m.toLowerCase().includes("stt"),
    );
  }
}
