import { describe, expect, test } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { TtsFallbackProvider } from "../fallback.ts";
import { TtsFallbackChain } from "../fallback.ts";
import type { GpuWorkerConfig } from "../manager.ts";
import { GPUManager } from "../manager.ts";
import { STTClient } from "../stt-client.ts";
import { TTSClient } from "../tts-client.ts";
import { VoicePipeline } from "../voice-pipeline.ts";

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

function makeConfig(overrides?: Partial<GpuWorkerConfig>): GpuWorkerConfig {
  return {
    url: "http://localhost:8420",
    timeoutMs: 5_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// GPUManager tests
// ---------------------------------------------------------------------------

describe("GPUManager", () => {
  test("checkHealth handles connection error", async () => {
    // Use a URL that will definitely refuse connections
    const config = makeConfig({ url: "http://127.0.0.1:1" });
    const manager = new GPUManager(config, logger);

    const result = await manager.checkHealth();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.GPU_UNAVAILABLE);
    }
    expect(manager.isAvailable).toBe(false);
  });

  test("request adds API key header when configured", async () => {
    let capturedHeaders: Headers | undefined;

    // Mock global fetch to capture the request
    const originalFetch = globalThis.fetch;
    const mockFetch = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    Object.assign(mockFetch, { preconnect: originalFetch.preconnect });
    globalThis.fetch = mockFetch as typeof fetch;

    try {
      const config = makeConfig({ apiKey: "test-secret-key" });
      const manager = new GPUManager(config, logger);

      await manager.request("/test");

      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders?.get("X-API-Key")).toBe("test-secret-key");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("request does not add API key header when not configured", async () => {
    let capturedHeaders: Headers | undefined;

    const originalFetch = globalThis.fetch;
    const mockFetch2 = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    Object.assign(mockFetch2, { preconnect: originalFetch.preconnect });
    globalThis.fetch = mockFetch2 as typeof fetch;

    try {
      const config = makeConfig(); // no apiKey
      const manager = new GPUManager(config, logger);

      await manager.request("/test");

      expect(capturedHeaders).toBeDefined();
      expect(capturedHeaders?.get("X-API-Key")).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// TTSClient tests
// ---------------------------------------------------------------------------

describe("TTSClient", () => {
  test("synthesize returns error when GPU unavailable", async () => {
    const config = makeConfig();
    const manager = new GPUManager(config, logger);
    // manager.isAvailable is false by default (no successful health check)
    const client = new TTSClient(manager, logger);

    const result = await client.synthesize({ text: "Hello world" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.GPU_UNAVAILABLE);
    }
  });
});

// ---------------------------------------------------------------------------
// STTClient tests
// ---------------------------------------------------------------------------

describe("STTClient", () => {
  test("transcribe returns error when GPU unavailable", async () => {
    const config = makeConfig();
    const manager = new GPUManager(config, logger);
    const client = new STTClient(manager, logger);

    const audio = new Uint8Array([0, 1, 2, 3]);
    const result = await client.transcribe(audio);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.GPU_UNAVAILABLE);
    }
  });
});

// ---------------------------------------------------------------------------
// VoicePipeline tests
// ---------------------------------------------------------------------------

describe("VoicePipeline", () => {
  test("splitSentences splits correctly", () => {
    const sentences = VoicePipeline.splitSentences("Hello there. How are you? I am fine! Thanks for asking.");
    expect(sentences).toEqual(["Hello there.", "How are you?", "I am fine!", "Thanks for asking."]);
  });

  test("splitSentences handles empty string", () => {
    const sentences = VoicePipeline.splitSentences("");
    expect(sentences).toEqual([]);
  });

  test("splitSentences handles single sentence", () => {
    const sentences = VoicePipeline.splitSentences("Just one sentence.");
    expect(sentences).toEqual(["Just one sentence."]);
  });
});

// ---------------------------------------------------------------------------
// TtsFallbackChain tests
// ---------------------------------------------------------------------------

describe("TtsFallbackChain", () => {
  function makeProvider(
    name: string,
    available: boolean,
    result: Result<Uint8Array, EidolonError>,
  ): TtsFallbackProvider {
    return {
      name,
      isAvailable: async () => available,
      synthesize: async () => result,
    };
  }

  test("synthesize tries providers in order and returns first success", async () => {
    const callOrder: string[] = [];

    const provider1: TtsFallbackProvider = {
      name: "first",
      isAvailable: async () => true,
      synthesize: async () => {
        callOrder.push("first");
        return Ok(new Uint8Array([1, 2, 3]));
      },
    };

    const provider2: TtsFallbackProvider = {
      name: "second",
      isAvailable: async () => true,
      synthesize: async () => {
        callOrder.push("second");
        return Ok(new Uint8Array([4, 5, 6]));
      },
    };

    const chain = new TtsFallbackChain([provider1, provider2], logger);
    const result = await chain.synthesize("test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(new Uint8Array([1, 2, 3]));
    }
    expect(callOrder).toEqual(["first"]);
  });

  test("synthesize falls through to next on failure", async () => {
    const failing = makeProvider("failing", true, Err(createError(ErrorCode.TTS_FAILED, "GPU error")));
    const working = makeProvider("working", true, Ok(new Uint8Array([7, 8, 9])));

    const chain = new TtsFallbackChain([failing, working], logger);
    const result = await chain.synthesize("test");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(new Uint8Array([7, 8, 9]));
    }
  });

  test("getAvailableProvider returns first available", async () => {
    const unavailable = makeProvider("unavailable", false, Err(createError(ErrorCode.TTS_FAILED, "nope")));
    const available = makeProvider("available", true, Ok(new Uint8Array([1])));

    const chain = new TtsFallbackChain([unavailable, available], logger);
    const name = await chain.getAvailableProvider();

    expect(name).toBe("available");
  });

  test("getAvailableProvider returns null when none available", async () => {
    const unavailable = makeProvider("down", false, Err(createError(ErrorCode.TTS_FAILED, "nope")));

    const chain = new TtsFallbackChain([unavailable], logger);
    const name = await chain.getAvailableProvider();

    expect(name).toBeNull();
  });
});
