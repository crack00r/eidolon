/**
 * TTS fallback chain — tries providers in priority order.
 *
 * Chain order: Qwen3-TTS (GPU) -> system TTS -> text-only (empty audio).
 * Each provider implements TtsFallbackProvider; the chain tries them
 * sequentially until one succeeds.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TtsFallbackProvider {
  readonly name: string;
  isAvailable(): Promise<boolean>;
  synthesize(text: string): Promise<Result<Uint8Array, EidolonError>>;
}

// ---------------------------------------------------------------------------
// TtsFallbackChain
// ---------------------------------------------------------------------------

export class TtsFallbackChain {
  private readonly providers: readonly TtsFallbackProvider[];
  private readonly logger: Logger;

  constructor(providers: readonly TtsFallbackProvider[], logger: Logger) {
    this.providers = providers;
    this.logger = logger.child("tts-fallback");
  }

  /** Try each provider in order, return first successful result. */
  async synthesize(text: string): Promise<Result<Uint8Array, EidolonError>> {
    const errors: string[] = [];

    for (const provider of this.providers) {
      const available = await provider.isAvailable();
      if (!available) {
        this.logger.debug("synthesize", `Provider ${provider.name} not available, skipping`);
        errors.push(`${provider.name}: not available`);
        continue;
      }

      const result = await provider.synthesize(text);
      if (result.ok) {
        this.logger.debug("synthesize", `Provider ${provider.name} succeeded`, {
          audioBytes: result.value.byteLength,
        });
        return result;
      }

      this.logger.warn("synthesize", `Provider ${provider.name} failed: ${result.error.message}`);
      errors.push(`${provider.name}: ${result.error.message}`);
    }

    return Err(createError(ErrorCode.TTS_FAILED, `All TTS providers failed: ${errors.join("; ")}`));
  }

  /** Get the name of the first available provider, or null if none. */
  async getAvailableProvider(): Promise<string | null> {
    for (const provider of this.providers) {
      const available = await provider.isAvailable();
      if (available) {
        return provider.name;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Built-in fallback: text-only (returns empty audio)
// ---------------------------------------------------------------------------

export const textOnlyProvider: TtsFallbackProvider = {
  name: "text-only",
  async isAvailable(): Promise<boolean> {
    return true;
  },
  async synthesize(_text: string): Promise<Result<Uint8Array, EidolonError>> {
    return Ok(new Uint8Array(0));
  },
};
