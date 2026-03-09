/**
 * TTS fallback providers -- GPU worker and system TTS implementations.
 *
 * Tier 1: GpuTtsProvider -- Qwen3-TTS via GPU Worker (remote HTTP)
 * Tier 2: SystemTtsProvider -- OS-native TTS (macOS `say`, Linux `espeak`)
 * Tier 3: textOnlyProvider from fallback.ts (always available, empty audio)
 *
 * Each provider implements TtsFallbackProvider from fallback.ts.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { CircuitBreaker } from "../health/circuit-breaker.ts";
import type { Logger } from "../logging/logger.ts";
import type { TtsFallbackProvider } from "./fallback.ts";
import { textOnlyProvider } from "./fallback.ts";
import type { GPUWorkerPool } from "./pool.ts";

// ---------------------------------------------------------------------------
// Tier 1: GPU TTS Provider (Qwen3-TTS via GPU Worker pool)
// ---------------------------------------------------------------------------

export interface GpuTtsProviderConfig {
  /** Default voice name. */
  readonly voice?: string;
  /** Default audio format. */
  readonly format?: "opus" | "wav" | "mp3";
  /** Speed multiplier. */
  readonly speed?: number;
}

export class GpuTtsProvider implements TtsFallbackProvider {
  readonly name = "gpu-qwen3-tts";
  private readonly pool: GPUWorkerPool;
  private readonly circuitBreaker: CircuitBreaker | null;
  private readonly config: GpuTtsProviderConfig;
  private readonly logger: Logger;

  constructor(pool: GPUWorkerPool, logger: Logger, config?: GpuTtsProviderConfig, circuitBreaker?: CircuitBreaker) {
    this.pool = pool;
    this.logger = logger.child("gpu-tts-provider");
    this.config = config ?? {};
    this.circuitBreaker = circuitBreaker ?? null;
  }

  async isAvailable(): Promise<boolean> {
    // Check circuit breaker first
    if (this.circuitBreaker !== null) {
      const status = this.circuitBreaker.getStatus();
      if (status.state === "open") {
        return false;
      }
    }
    return this.pool.hasCapability("tts");
  }

  async synthesize(text: string): Promise<Result<Uint8Array, EidolonError>> {
    const result = await this.pool.tts({
      text,
      voice: this.config.voice,
      speed: this.config.speed,
      format: this.config.format,
    });

    if (!result.ok) {
      return Err(result.error);
    }

    return Ok(result.value.audio);
  }
}

// ---------------------------------------------------------------------------
// Tier 2: System TTS Provider (macOS `say`, Linux `espeak`)
// ---------------------------------------------------------------------------

/** Detect the current platform's TTS command. */
function detectSystemTtsCommand(): { command: string; args: string[]; useStdin: boolean } | null {
  const platform = typeof process !== "undefined" ? process.platform : "";

  if (platform === "darwin") {
    // `--` separates flags from the text argument to prevent flag injection
    return { command: "say", args: ["-o", "/dev/stdout", "--data-format=LEI16@22050", "--"], useStdin: false };
  }

  if (platform === "linux") {
    // espeak-ng uses `-stdin` to read text from stdin, preventing flag injection
    return { command: "espeak-ng", args: ["--stdout", "-stdin"], useStdin: true };
  }

  return null;
}

/** Timeout for system TTS subprocess in milliseconds. */
const SYSTEM_TTS_TIMEOUT_MS = 30_000;

/** Maximum text length for system TTS to prevent resource abuse. */
const MAX_TTS_TEXT_LENGTH = 10_000;

/** Strip control characters that could interfere with TTS subprocess. */
function sanitizeTtsText(text: string): string {
  // Remove ASCII control chars except newline/tab, and limit length
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional stripping of control chars
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").slice(0, MAX_TTS_TEXT_LENGTH);
}

export class SystemTtsProvider implements TtsFallbackProvider {
  readonly name = "system-tts";
  private readonly logger: Logger;
  private cachedAvailable: boolean | null = null;

  constructor(logger: Logger) {
    this.logger = logger.child("system-tts-provider");
  }

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) {
      return this.cachedAvailable;
    }

    const ttsCmd = detectSystemTtsCommand();
    if (ttsCmd === null) {
      this.cachedAvailable = false;
      return false;
    }

    // Check if the command exists
    try {
      const proc = Bun.spawn(["which", ttsCmd.command], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      this.cachedAvailable = exitCode === 0;
    } catch {
      // Intentional: command lookup failure means TTS is not available
      this.cachedAvailable = false;
    }

    return this.cachedAvailable;
  }

  async synthesize(text: string): Promise<Result<Uint8Array, EidolonError>> {
    const ttsCmd = detectSystemTtsCommand();
    if (ttsCmd === null) {
      return Err(createError(ErrorCode.TTS_FAILED, "No system TTS command available on this platform"));
    }

    try {
      const safeText = sanitizeTtsText(text);
      const spawnArgs = ttsCmd.useStdin ? [ttsCmd.command, ...ttsCmd.args] : [ttsCmd.command, ...ttsCmd.args, safeText];
      const proc = Bun.spawn(spawnArgs, {
        stdout: "pipe",
        stderr: "pipe",
        stdin: ttsCmd.useStdin ? "pipe" : undefined,
      });

      // For stdin-based commands (espeak-ng), write text via stdin
      if (ttsCmd.useStdin && proc.stdin) {
        proc.stdin.write(new TextEncoder().encode(safeText));
        proc.stdin.end();
      }

      // Enforce a timeout to prevent runaway subprocesses
      const timeoutId = setTimeout(() => {
        proc.kill();
      }, SYSTEM_TTS_TIMEOUT_MS);

      // Read stdout/stderr concurrently with waiting for exit to avoid deadlock
      const [exitCode, stdoutBuf, stderrText] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).arrayBuffer(),
        new Response(proc.stderr).text(),
      ]);
      clearTimeout(timeoutId);

      if (exitCode !== 0) {
        return Err(createError(ErrorCode.TTS_FAILED, `System TTS failed (exit ${exitCode}): ${stderrText.slice(0, 200)}`));
      }

      const audio = new Uint8Array(stdoutBuf);

      this.logger.debug("synthesize", "System TTS completed", {
        textLength: text.length,
        audioBytes: audio.byteLength,
      });

      return Ok(audio);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.TTS_FAILED, `System TTS error: ${message}`, err));
    }
  }
}

// ---------------------------------------------------------------------------
// Factory: create the default 3-tier fallback chain providers
// ---------------------------------------------------------------------------

export interface CreateFallbackProvidersOptions {
  readonly pool: GPUWorkerPool;
  readonly logger: Logger;
  readonly gpuConfig?: GpuTtsProviderConfig;
  readonly circuitBreaker?: CircuitBreaker;
}

/**
 * Create the standard 3-tier TTS provider list:
 * 1. GPU Qwen3-TTS (remote)
 * 2. System TTS (local)
 * 3. Text-only (always available, from fallback.ts)
 */
export function createDefaultTtsProviders(options: CreateFallbackProvidersOptions): TtsFallbackProvider[] {
  return [
    new GpuTtsProvider(options.pool, options.logger, options.gpuConfig, options.circuitBreaker),
    new SystemTtsProvider(options.logger),
    textOnlyProvider,
  ];
}
