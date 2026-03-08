/**
 * Tests for LLM provider response schema validation.
 *
 * Verifies that malformed API responses from Ollama and llama.cpp are
 * handled gracefully (return errors, don't crash) rather than causing
 * undefined property access.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LLMStreamEvent } from "@eidolon/protocol";
import type { Server } from "bun";
import type { Logger } from "../../logging/logger.ts";
import { LlamaCppProvider } from "../llamacpp-provider.ts";
import { OllamaProvider } from "../ollama-provider.ts";

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

/** Collect all events from an async iterable into an array. */
async function collectStream(iter: AsyncIterable<LLMStreamEvent>): Promise<LLMStreamEvent[]> {
  const items: LLMStreamEvent[] = [];
  for await (const item of iter) {
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Ollama: malformed response handling
// ---------------------------------------------------------------------------

describe("OllamaProvider schema validation", () => {
  let server: Server<unknown>;
  let responseBody: unknown = {};
  let statusCode = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/tags") {
          return new Response(JSON.stringify(responseBody), {
            status: statusCode,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/chat") {
          return new Response(JSON.stringify(responseBody), {
            status: statusCode,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (url.pathname === "/api/embeddings") {
          return new Response(JSON.stringify(responseBody), {
            status: statusCode,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  function createProvider(): OllamaProvider {
    const host = `http://localhost:${server.port}`;
    return new OllamaProvider(
      { enabled: true, host, defaultModel: "test", allowPrivateHosts: true, models: {} },
      logger,
      true,
    );
  }

  test("listModels returns empty array on malformed tags response", async () => {
    responseBody = { notModels: "wrong shape" };
    statusCode = 200;

    const provider = createProvider();
    const models = await provider.listModels();

    expect(models).toEqual([]);
  });

  test("listModels returns empty array when models array has wrong item shape", async () => {
    responseBody = { models: [{ wrong: "shape" }] };
    statusCode = 200;

    const provider = createProvider();
    const models = await provider.listModels();

    expect(models).toEqual([]);
  });

  test("complete throws on malformed chat response (missing message)", async () => {
    responseBody = { model: "test", done: true };
    statusCode = 200;

    const provider = createProvider();

    await expect(provider.complete([{ role: "user", content: "Hi" }])).rejects.toThrow(/validation failed/);
  });

  test("complete throws on completely invalid response", async () => {
    responseBody = "just a string";
    statusCode = 200;

    const provider = createProvider();

    await expect(provider.complete([{ role: "user", content: "Hi" }])).rejects.toThrow(/validation failed/);
  });

  test("complete throws when message content is not a string", async () => {
    responseBody = {
      model: "test",
      message: { role: "assistant", content: 42 },
      done: true,
    };
    statusCode = 200;

    const provider = createProvider();

    await expect(provider.complete([{ role: "user", content: "Hi" }])).rejects.toThrow(/validation failed/);
  });

  test("complete succeeds with valid response", async () => {
    responseBody = {
      model: "test-model",
      message: { role: "assistant", content: "Hello!" },
      done: true,
      prompt_eval_count: 10,
      eval_count: 5,
    };
    statusCode = 200;

    const provider = createProvider();
    const result = await provider.complete([{ role: "user", content: "Hi" }]);

    expect(result.content).toBe("Hello!");
    expect(result.model).toBe("test-model");
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(5);
  });

  test("stream skips malformed chunks without crashing", async () => {
    // Serve malformed streaming data
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/chat") {
          const chunks = [
            '{"not":"valid_chunk"}\n',
            '{"message":{"role":"assistant","content":"ok"},"done":false}\n',
            '{"done":true,"prompt_eval_count":5,"eval_count":3}\n',
          ].join("");
          return new Response(chunks, {
            status: 200,
            headers: { "Content-Type": "application/x-ndjson" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const provider = createProvider();
    const events = await collectStream(provider.stream([{ role: "user", content: "Hi" }]));

    // Should have text event from the valid chunk + done event
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBe(1);
    expect(textEvents[0]?.text).toBe("ok");

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
  });

  test("embed throws on malformed embeddings response", async () => {
    // Restore the multiplex server for embedding endpoint
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ notEmbedding: [1, 2, 3] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const provider = createProvider();

    await expect(provider.embed(["test text"])).rejects.toThrow(/validation failed/);
  });

  test("embed succeeds with valid response", async () => {
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const provider = createProvider();
    const results = await provider.embed(["test text"]);

    expect(results.length).toBe(1);
    expect(results[0]?.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// LlamaCppProvider: malformed response handling
// ---------------------------------------------------------------------------

describe("LlamaCppProvider schema validation", () => {
  let server: Server<unknown>;
  let responseBody: unknown = {};
  let statusCode = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/health") {
          return new Response("OK", { status: 200 });
        }
        if (url.pathname === "/v1/chat/completions") {
          return new Response(JSON.stringify(responseBody), {
            status: statusCode,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  function createProvider(): LlamaCppProvider {
    return new LlamaCppProvider(
      { enabled: true, serverPath: "", modelPath: "", gpuLayers: 0, contextLength: 8192, port: server.port ?? 0 },
      logger,
    );
  }

  test("complete throws on malformed response (missing choices)", async () => {
    responseBody = { model: "test" };
    statusCode = 200;

    const provider = createProvider();

    await expect(provider.complete([{ role: "user", content: "Hi" }])).rejects.toThrow(/validation failed/);
  });

  test("complete throws on empty choices array", async () => {
    responseBody = { choices: [], model: "test" };
    statusCode = 200;

    const provider = createProvider();

    await expect(provider.complete([{ role: "user", content: "Hi" }])).rejects.toThrow(/validation failed/);
  });

  test("complete throws when choice has wrong shape", async () => {
    responseBody = {
      choices: [{ text: "wrong format" }],
      model: "test",
    };
    statusCode = 200;

    const provider = createProvider();

    await expect(provider.complete([{ role: "user", content: "Hi" }])).rejects.toThrow(/validation failed/);
  });

  test("complete throws on completely invalid JSON shape", async () => {
    responseBody = [1, 2, 3];
    statusCode = 200;

    const provider = createProvider();

    await expect(provider.complete([{ role: "user", content: "Hi" }])).rejects.toThrow(/validation failed/);
  });

  test("complete succeeds with valid response", async () => {
    responseBody = {
      choices: [
        {
          message: { role: "assistant", content: "Hello from llama!" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 15, completion_tokens: 8 },
      model: "local-model",
    };
    statusCode = 200;

    const provider = createProvider();
    const result = await provider.complete([{ role: "user", content: "Hi" }]);

    expect(result.content).toBe("Hello from llama!");
    expect(result.model).toBe("local-model");
    expect(result.usage.inputTokens).toBe(15);
    expect(result.usage.outputTokens).toBe(8);
  });

  test("stream skips malformed SSE chunks without crashing", async () => {
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions") {
          const chunks = [
            'data: {"not":"valid"}\n\n',
            'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
            "data: [DONE]\n\n",
          ].join("");
          return new Response(chunks, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.pathname === "/health") {
          return new Response("OK", { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const provider = createProvider();
    const events = await collectStream(provider.stream([{ role: "user", content: "Hi" }]));

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBe(1);
    expect(textEvents[0]?.text).toBe("hello");

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
  });

  test("stream handles completely empty choices array in chunk gracefully", async () => {
    server.stop(true);
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions") {
          const chunks = [
            'data: {"choices":[]}\n\n',
            'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
            "data: [DONE]\n\n",
          ].join("");
          return new Response(chunks, {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        if (url.pathname === "/health") {
          return new Response("OK", { status: 200 });
        }
        return new Response("Not found", { status: 404 });
      },
    });

    const provider = createProvider();
    const events = await collectStream(provider.stream([{ role: "user", content: "Hi" }]));

    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBe(1);
    expect(textEvents[0]?.text).toBe("hi");
  });
});
