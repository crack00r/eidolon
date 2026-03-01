/**
 * STT client — HTTP client for the GPU worker's POST /stt/transcribe endpoint.
 *
 * Sends audio bytes and receives transcribed text.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";
import type { GPUManager } from "./manager.js";

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

    const mime = mimeType ?? "audio/wav";
    const extension = mime.split("/")[1] ?? "wav";

    try {
      const formData = new FormData();
      const blob = new Blob([audio], { type: mime });
      formData.append("file", blob, `audio.${extension}`);

      const response = await fetch(`${this.gpu.baseUrl}/stt/transcribe`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        return Err(createError(ErrorCode.STT_FAILED, `STT transcription failed (${response.status}): ${errorText}`));
      }

      const result = (await response.json()) as SttResult;

      this.logger.debug("transcribe", "STT completed", {
        textLength: result.text.length,
        language: result.language,
        confidence: result.confidence,
      });

      return Ok(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.STT_FAILED, `STT transcription request failed: ${message}`, err));
    }
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
