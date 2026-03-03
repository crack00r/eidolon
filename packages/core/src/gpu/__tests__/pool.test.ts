import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ErrorCode } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { GPUWorkerPoolConfig } from "../pool.ts";
import { GPUWorkerPool } from "../pool.ts";
import type { GPUWorkerConfig } from "../worker.ts";

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

/** Create a worker config pointing to the mock fetch server. */
function makeWorkerConfig(overrides?: Partial<GPUWorkerConfig>): GPUWorkerConfig {
  return {
    name: "test-worker",
    url: "http://localhost:19999",
    capabilities: ["tts", "stt"],
    apiKey: "test-key",
    ...overrides,
  };
}

function makePoolConfig(workers: GPUWorkerConfig[], overrides?: Partial<Omit<GPUWorkerPoolConfig, "workers">>): GPUWorkerPoolConfig {
  return {
    workers,
    healthCheckIntervalMs: 60_000, // long interval to avoid interference
    loadBalancing: "least-connections",
    maxRetries: 2,
    ...overrides,
  };
}

// Save and restore global fetch
let originalFetch: typeof globalThis.fetch;

function mockFetchWith(handler: (url: string, init?: RequestInit) => Promise<Response>): void {
  const mockFn = handler as typeof fetch;
  Object.assign(mockFn, { preconnect: originalFetch.preconnect });
  globalThis.fetch = mockFn;
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// GPUWorkerPool tests
// ---------------------------------------------------------------------------

describe("GPUWorkerPool", () => {
  test("creates pool with correct worker count", () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([
        makeWorkerConfig({ name: "w1" }),
        makeWorkerConfig({ name: "w2" }),
      ]),
      logger,
    );

    expect(pool.size).toBe(2);
    pool.dispose();
  });

  test("getPoolStatus returns correct worker count", () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([
        makeWorkerConfig({ name: "w1" }),
        makeWorkerConfig({ name: "w2" }),
        makeWorkerConfig({ name: "w3" }),
      ]),
      logger,
    );

    const status = pool.getPoolStatus();
    expect(status.totalWorkers).toBe(3);
    // Without health checks, all workers are "unhealthy" (no health data)
    expect(status.unhealthyWorkers).toBe(3);
    expect(status.healthyWorkers).toBe(0);
    expect(status.totalActiveRequests).toBe(0);
    expect(status.workers).toHaveLength(3);
    pool.dispose();
  });

  test("selectWorker returns null with no workers", () => {
    const pool = new GPUWorkerPool(makePoolConfig([]), logger);
    const worker = pool.selectWorker("tts");
    expect(worker).toBeNull();
    pool.dispose();
  });

  test("selectWorker filters by capability", () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([
        makeWorkerConfig({ name: "tts-only", capabilities: ["tts"] }),
        makeWorkerConfig({ name: "stt-only", capabilities: ["stt"] }),
      ]),
      logger,
    );

    const ttsWorker = pool.selectWorker("tts");
    expect(ttsWorker?.name).toBe("tts-only");

    const sttWorker = pool.selectWorker("stt");
    expect(sttWorker?.name).toBe("stt-only");

    pool.dispose();
  });

  test("hasCapability returns correct values", () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([
        makeWorkerConfig({ name: "tts-only", capabilities: ["tts"] }),
      ]),
      logger,
    );

    expect(pool.hasCapability("tts")).toBe(true);
    expect(pool.hasCapability("stt")).toBe(false);
    expect(pool.hasCapability("realtime")).toBe(false);
    pool.dispose();
  });

  test("tts validates empty text", async () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig()]),
      logger,
    );

    const result = await pool.tts({ text: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.TTS_FAILED);
      expect(result.error.message).toContain("empty");
    }
    pool.dispose();
  });

  test("tts validates text length", async () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig()]),
      logger,
    );

    const result = await pool.tts({ text: "x".repeat(10_001) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.TTS_FAILED);
      expect(result.error.message).toContain("too long");
    }
    pool.dispose();
  });

  test("tts validates speed range", async () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig()]),
      logger,
    );

    const result = await pool.tts({ text: "hello", speed: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.TTS_FAILED);
      expect(result.error.message).toContain("speed");
    }
    pool.dispose();
  });

  test("stt validates empty audio", async () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig()]),
      logger,
    );

    const result = await pool.stt(new Uint8Array(0));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.STT_FAILED);
      expect(result.error.message).toContain("empty");
    }
    pool.dispose();
  });

  test("stt validates mime type", async () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig()]),
      logger,
    );

    const result = await pool.stt(new Uint8Array([1, 2, 3]), "video/mp4");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.STT_FAILED);
      expect(result.error.message).toContain("Unsupported");
    }
    pool.dispose();
  });

  test("tts succeeds with mock GPU worker", async () => {
    mockFetchWith(async (_url, init) => {
      // Health check or TTS request
      const urlStr = typeof _url === "string" ? _url : "";
      if (urlStr.includes("/health")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            uptimeSeconds: 100,
            gpu: { available: true, name: "RTX 5080" },
            modelsLoaded: ["tts"],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      // TTS response: return binary audio
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "audio/opus" },
      });
    });

    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig({ name: "gpu-1" })]),
      logger,
    );

    const result = await pool.tts({ text: "Hello world" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audio.byteLength).toBe(4);
      expect(result.value.format).toBe("opus");
    }
    pool.dispose();
  });

  test("tts fails over to next worker on error", async () => {
    let requestCount = 0;

    mockFetchWith(async (url) => {
      const urlStr = typeof url === "string" ? url : "";

      // Health checks succeed for all workers
      if (urlStr.includes("/health")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            uptimeSeconds: 100,
            gpu: { available: true },
            modelsLoaded: ["tts"],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }

      requestCount++;
      // First worker fails
      if (urlStr.includes("worker1")) {
        return new Response("Internal Server Error", { status: 500 });
      }
      // Second worker succeeds
      return new Response(new Uint8Array([5, 6, 7]), {
        headers: { "content-type": "audio/opus" },
      });
    });

    const pool = new GPUWorkerPool(
      makePoolConfig([
        makeWorkerConfig({ name: "worker1", url: "http://worker1:8420" }),
        makeWorkerConfig({ name: "worker2", url: "http://worker2:8420" }),
      ]),
      logger,
    );

    const result = await pool.tts({ text: "Hello" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.audio).toEqual(new Uint8Array([5, 6, 7]));
    }
    // Both workers were tried
    expect(requestCount).toBe(2);
    pool.dispose();
  });

  test("tts returns error when all workers fail", async () => {
    mockFetchWith(async () => {
      return new Response("Internal Server Error", { status: 500 });
    });

    const pool = new GPUWorkerPool(
      makePoolConfig(
        [
          makeWorkerConfig({ name: "w1", url: "http://w1:8420" }),
          makeWorkerConfig({ name: "w2", url: "http://w2:8420" }),
        ],
        { maxRetries: 1 },
      ),
      logger,
    );

    const result = await pool.tts({ text: "Hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.GPU_UNAVAILABLE);
    }
    pool.dispose();
  });

  test("tts respects maxRetries config", async () => {
    let ttsRequestCount = 0;

    mockFetchWith(async (url) => {
      const urlStr = typeof url === "string" ? url : "";
      if (urlStr.includes("/health")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            uptimeSeconds: 100,
            gpu: { available: true },
            modelsLoaded: ["tts"],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      // All TTS requests fail
      ttsRequestCount++;
      return new Response("Service Unavailable", { status: 503 });
    });

    // 3 workers but maxRetries = 1: should try initial + 1 retry = 2 total attempts
    const pool = new GPUWorkerPool(
      makePoolConfig(
        [
          makeWorkerConfig({ name: "w1", url: "http://w1:8420" }),
          makeWorkerConfig({ name: "w2", url: "http://w2:8420" }),
          makeWorkerConfig({ name: "w3", url: "http://w3:8420" }),
        ],
        { maxRetries: 1 },
      ),
      logger,
    );

    const result = await pool.tts({ text: "retry limit test" });
    expect(result.ok).toBe(false);
    // maxRetries = 1 means: attempt 0 + 1 retry = 2 total TTS requests
    expect(ttsRequestCount).toBe(2);
    pool.dispose();
  });

  test("tts returns GPU_UNAVAILABLE when no workers in pool", async () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([], { maxRetries: 0 }),
      logger,
    );

    const result = await pool.tts({ text: "Hello" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.GPU_UNAVAILABLE);
    }
    pool.dispose();
  });

  test("stt succeeds with mock GPU worker", async () => {
    mockFetchWith(async (url) => {
      const urlStr = typeof url === "string" ? url : "";
      if (urlStr.includes("/health")) {
        return new Response(
          JSON.stringify({
            status: "ok",
            uptimeSeconds: 100,
            gpu: { available: true },
            modelsLoaded: ["stt"],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          text: "Hello world",
          language: "en",
          confidence: 0.95,
          durationSeconds: 2.5,
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig({ name: "gpu-1" })]),
      logger,
    );

    const audio = new Uint8Array([1, 2, 3, 4]);
    const result = await pool.stt(audio);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.text).toBe("Hello world");
      expect(result.value.language).toBe("en");
    }
    pool.dispose();
  });

  test("health check updates worker state", async () => {
    mockFetchWith(async () => {
      return new Response(
        JSON.stringify({
          status: "ok",
          uptimeSeconds: 100,
          gpu: { available: true, name: "RTX 5080" },
          modelsLoaded: ["tts", "stt"],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });

    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig({ name: "gpu-1" })]),
      logger,
    );

    await pool.checkAllHealth();

    const status = pool.getPoolStatus();
    expect(status.healthyWorkers).toBe(1);
    expect(status.unhealthyWorkers).toBe(0);

    const workerInfo = status.workers[0];
    expect(workerInfo?.health).not.toBeNull();
    expect(workerInfo?.health?.status).toBe("ok");

    pool.dispose();
  });

  test("health check marks worker as unhealthy on failure", async () => {
    mockFetchWith(async () => {
      return new Response("Service Unavailable", { status: 503 });
    });

    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig({ name: "gpu-1" })]),
      logger,
    );

    await pool.checkAllHealth();

    const status = pool.getPoolStatus();
    expect(status.healthyWorkers).toBe(0);
    expect(status.unhealthyWorkers).toBe(1);

    pool.dispose();
  });

  test("dispose stops health check timer", () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig({ name: "gpu-1" })], {
        healthCheckIntervalMs: 100,
      }),
      logger,
    );

    pool.startHealthChecks();
    pool.dispose();

    // Should not throw -- dispose is idempotent
    pool.dispose();
  });

  test("startHealthChecks is idempotent", () => {
    const pool = new GPUWorkerPool(
      makePoolConfig([makeWorkerConfig({ name: "gpu-1" })], {
        healthCheckIntervalMs: 60_000,
      }),
      logger,
    );

    pool.startHealthChecks();
    pool.startHealthChecks(); // Should not create a second timer

    pool.dispose();
  });
});
