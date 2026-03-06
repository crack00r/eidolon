import { describe, expect, test } from "bun:test";
import type { CircuitBreakerStatus, EidolonError, Result } from "@eidolon/protocol";
import { createError, ErrorCode, Ok } from "@eidolon/protocol";
import type { CircuitBreaker } from "../../health/circuit-breaker.ts";
import type { Logger } from "../../logging/logger.ts";
import { textOnlyProvider } from "../fallback.ts";
import type { GPUWorkerPool } from "../pool.ts";
import type { TtsResult } from "../tts-client.ts";
import { createDefaultTtsProviders, GpuTtsProvider } from "../tts-providers.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

const logger = createSilentLogger();

/** Minimal mock of GPUWorkerPool for TTS provider tests. */
function createMockPool(overrides?: {
  ttsResult?: Result<TtsResult, EidolonError>;
  hasTtsCapability?: boolean;
}): GPUWorkerPool {
  const hasTts = overrides?.hasTtsCapability ?? true;
  const ttsResult: Result<TtsResult, EidolonError> =
    overrides?.ttsResult ??
    Ok({
      audio: new Uint8Array([1, 2, 3, 4]),
      format: "opus",
      durationMs: 100,
    });

  return {
    hasCapability: (cap: string) => cap === "tts" && hasTts,
    tts: async () => ttsResult,
    stt: async () => Ok({ text: "", language: "en", confidence: 1, segments: [] }),
    selectWorker: () => null,
    getPoolStatus: () => ({
      totalWorkers: 1,
      healthyWorkers: 1,
      degradedWorkers: 0,
      unhealthyWorkers: 0,
      totalActiveRequests: 0,
      workers: [],
    }),
    startHealthChecks: () => {},
    stopHealthChecks: () => {},
    checkAllHealth: async () => {},
    dispose: () => {},
    get size() {
      return 1;
    },
  } as unknown as GPUWorkerPool;
}

/** Minimal mock of CircuitBreaker. */
function createMockCircuitBreaker(state: "closed" | "open" | "half_open" = "closed") {
  const status: CircuitBreakerStatus = {
    name: "test-cb",
    state,
    failures: 0,
  };

  return {
    getStatus: () => status,
    execute: async <T>(fn: () => Promise<T>): Promise<Result<T, EidolonError>> => {
      if (state === "open") {
        return { ok: false, error: createError(ErrorCode.CIRCUIT_OPEN, "Circuit is open") };
      }
      try {
        const result = await fn();
        return { ok: true, value: result };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: createError(ErrorCode.TTS_FAILED, message) };
      }
    },
    reset: () => {},
  } as unknown as CircuitBreaker;
}

// ---------------------------------------------------------------------------
// GpuTtsProvider
// ---------------------------------------------------------------------------

describe("GpuTtsProvider", () => {
  test("isAvailable returns true when pool has tts capability and circuit is closed", async () => {
    const pool = createMockPool({ hasTtsCapability: true });
    const provider = new GpuTtsProvider(pool, logger, {}, createMockCircuitBreaker("closed"));

    expect(await provider.isAvailable()).toBe(true);
  });

  test("isAvailable returns false when circuit breaker is open", async () => {
    const pool = createMockPool({ hasTtsCapability: true });
    const provider = new GpuTtsProvider(pool, logger, {}, createMockCircuitBreaker("open"));

    expect(await provider.isAvailable()).toBe(false);
  });

  test("isAvailable returns false when pool lacks tts capability", async () => {
    const pool = createMockPool({ hasTtsCapability: false });
    const provider = new GpuTtsProvider(pool, logger);

    expect(await provider.isAvailable()).toBe(false);
  });

  test("synthesize returns audio from pool on success", async () => {
    const expectedAudio = new Uint8Array([10, 20, 30]);
    const pool = createMockPool({
      ttsResult: Ok({ audio: expectedAudio, format: "opus", durationMs: 50 }),
    });
    const provider = new GpuTtsProvider(pool, logger);

    const result = await provider.synthesize("Hello");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(expectedAudio);
    }
  });

  test("synthesize returns error when pool TTS fails", async () => {
    const pool = createMockPool({
      ttsResult: { ok: false, error: createError(ErrorCode.GPU_UNAVAILABLE, "Worker offline") },
    });
    const provider = new GpuTtsProvider(pool, logger);

    const result = await provider.synthesize("Hello");
    expect(result.ok).toBe(false);
  });

  test("synthesize with circuit breaker wraps execution", async () => {
    const pool = createMockPool();
    const cb = createMockCircuitBreaker("closed");
    const provider = new GpuTtsProvider(pool, logger, {}, cb);

    const result = await provider.synthesize("Test text");
    expect(result.ok).toBe(true);
  });

  test("name is gpu-qwen3-tts", () => {
    const pool = createMockPool();
    const provider = new GpuTtsProvider(pool, logger);
    expect(provider.name).toBe("gpu-qwen3-tts");
  });
});

// ---------------------------------------------------------------------------
// textOnlyProvider
// ---------------------------------------------------------------------------

describe("textOnlyProvider", () => {
  test("is always available", async () => {
    expect(await textOnlyProvider.isAvailable()).toBe(true);
  });

  test("synthesize returns empty Uint8Array", async () => {
    const result = await textOnlyProvider.synthesize("Hello");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.byteLength).toBe(0);
    }
  });

  test("name is text-only", () => {
    expect(textOnlyProvider.name).toBe("text-only");
  });
});

// ---------------------------------------------------------------------------
// createDefaultTtsProviders
// ---------------------------------------------------------------------------

describe("createDefaultTtsProviders", () => {
  test("returns 3 providers in correct order", () => {
    const pool = createMockPool();
    const providers = createDefaultTtsProviders({ pool, logger });

    expect(providers).toHaveLength(3);
    expect(providers[0]?.name).toBe("gpu-qwen3-tts");
    expect(providers[1]?.name).toBe("system-tts");
    expect(providers[2]?.name).toBe("text-only");
  });

  test("passes circuit breaker to GPU provider", async () => {
    const pool = createMockPool({ hasTtsCapability: true });
    const cb = createMockCircuitBreaker("open");
    const providers = createDefaultTtsProviders({ pool, logger, circuitBreaker: cb });

    // GPU provider should be unavailable because CB is open
    const gpuProvider = providers[0];
    if (gpuProvider !== undefined) {
      expect(await gpuProvider.isAvailable()).toBe(false);
    }
  });
});
