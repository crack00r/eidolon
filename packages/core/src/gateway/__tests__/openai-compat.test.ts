import { describe, expect, test } from "bun:test";
import type { BrainConfig, LLMConfig } from "@eidolon/protocol";
import { FakeLLMProvider } from "@eidolon/test-utils";
import { ModelRouter } from "../../llm/router.ts";
import type { Logger } from "../../logging/logger.ts";
import { handleOpenAIRequest, type OpenAICompatDeps } from "../openai-compat.ts";

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

function makeRouter(provider?: FakeLLMProvider): ModelRouter {
  // Route conversation tasks to all provider types so fakes work
  const config: LLMConfig = {
    providers: {},
    routing: { conversation: ["claude", "ollama", "llamacpp"] },
  };
  const router = new ModelRouter(config, logger);
  if (provider) {
    router.registerProvider(provider);
  }
  return router;
}

/** Default auth token used by makeDeps and makeRequest/makeAuthRequest. */
const DEFAULT_TEST_TOKEN = "test-api-token";

function makeDeps(overrides?: Partial<OpenAICompatDeps>): OpenAICompatDeps {
  // By default wire up a fake provider so completions work
  const defaultProvider = FakeLLMProvider.withResponse("Hello from the LLM provider!", "ollama");
  defaultProvider.setStreamEvents([
    { type: "text", text: "Hello " },
    { type: "text", text: "world!" },
    { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
  ]);
  return {
    logger,
    router: makeRouter(defaultProvider),
    authToken: DEFAULT_TEST_TOKEN,
    ...overrides,
  };
}

function makeBrainConfig(overrides?: Partial<BrainConfig["model"]>): BrainConfig {
  return {
    accounts: [{ type: "oauth", name: "test", credential: "test", priority: 1, enabled: true }],
    model: {
      default: "claude-sonnet-4-20250514",
      complex: "claude-opus-4-20250514",
      fast: "claude-haiku-3-20250414",
      ...overrides,
    },
    session: { maxTurns: 50, compactAfter: 40, timeoutMs: 300_000 },
    mcpTemplates: [],
  };
}

function makeRequest(path: string, options?: RequestInit): Request {
  return new Request(`http://localhost:8419${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${DEFAULT_TEST_TOKEN}`,
      ...(options?.headers ?? {}),
    },
  });
}

/** Create a request without any auth header (for testing auth rejection). */
function makeUnauthRequest(path: string, options?: RequestInit): Request {
  return new Request(`http://localhost:8419${path}`, options);
}

function makeAuthRequest(path: string, token: string, options?: RequestInit): Request {
  return new Request(`http://localhost:8419${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options?.headers ?? {}),
    },
  });
}

function makeChatBody(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    model: "eidolon-default",
    messages: [{ role: "user", content: "Hello, world!" }],
    ...overrides,
  });
}

async function parseJsonBody(resp: Response): Promise<unknown> {
  return resp.json();
}

// ---------------------------------------------------------------------------
// Tests: Route matching
// ---------------------------------------------------------------------------

describe("handleOpenAIRequest", () => {
  describe("route matching", () => {
    test("returns null for non-/v1/ paths", async () => {
      const req = makeRequest("/health");
      const result = await handleOpenAIRequest(req, makeDeps());
      expect(result).toBeNull();
    });

    test("returns null for root path", async () => {
      const req = makeRequest("/");
      const result = await handleOpenAIRequest(req, makeDeps());
      expect(result).toBeNull();
    });

    test("returns null for /ws path", async () => {
      const req = makeRequest("/ws");
      const result = await handleOpenAIRequest(req, makeDeps());
      expect(result).toBeNull();
    });

    test("returns 404 for unknown /v1/ endpoint", async () => {
      const req = makeRequest("/v1/unknown");
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(404);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.type).toBe("invalid_request_error");
      expect(error.code).toBe("not_found");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Authentication
  // ---------------------------------------------------------------------------

  describe("authentication", () => {
    test("returns 503 when no authToken is configured", async () => {
      const req = makeUnauthRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps({ authToken: undefined }));
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(503);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe("auth_not_configured");
    });

    test("allows requests with valid Bearer token", async () => {
      const req = makeAuthRequest("/v1/models", "my-secret");
      const resp = await handleOpenAIRequest(req, makeDeps({ authToken: "my-secret" }));
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(200);
    });

    test("rejects requests with missing Authorization header", async () => {
      const req = makeUnauthRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps({ authToken: "my-secret" }));
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(401);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.type).toBe("authentication_error");
      expect(error.code).toBe("invalid_api_key");
    });

    test("rejects requests with wrong token", async () => {
      const req = makeAuthRequest("/v1/models", "wrong-token");
      const resp = await handleOpenAIRequest(req, makeDeps({ authToken: "correct-token" }));
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(401);
    });

    test("rejects requests with malformed Authorization header", async () => {
      const req = new Request("http://localhost:8419/v1/models", {
        headers: { Authorization: "Basic abc123" },
      });
      const resp = await handleOpenAIRequest(req, makeDeps({ authToken: "my-secret" }));
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: GET /v1/models
  // ---------------------------------------------------------------------------

  describe("GET /v1/models", () => {
    test("returns model list with eidolon-default", async () => {
      const req = makeRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(200);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.object).toBe("list");

      const data = body.data as Array<Record<string, unknown>>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0]?.id).toBe("eidolon-default");
      expect(data[0]?.object).toBe("model");
      expect(typeof data[0]?.created).toBe("number");
      expect(data[0]?.owned_by).toBe("eidolon");
    });

    test("includes brain config models when provided", async () => {
      const brainConfig = makeBrainConfig();
      const req = makeRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps({ brainConfig }));
      expect(resp).not.toBeNull();

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const data = body.data as Array<Record<string, unknown>>;

      const ids = data.map((m) => m.id);
      expect(ids).toContain("eidolon-default");
      expect(ids).toContain("claude-sonnet-4-20250514");
      expect(ids).toContain("claude-opus-4-20250514");
      expect(ids).toContain("claude-haiku-3-20250414");
    });

    test("deduplicates models when config has same model for multiple tiers", async () => {
      const brainConfig = makeBrainConfig({
        default: "claude-sonnet-4-20250514",
        complex: "claude-sonnet-4-20250514",
        fast: "claude-sonnet-4-20250514",
      });
      const req = makeRequest("/v1/models");
      // Use no-router deps to get a predictable count
      const resp = await handleOpenAIRequest(req, makeDeps({ brainConfig, router: makeRouter() }));

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const data = body.data as Array<Record<string, unknown>>;

      // eidolon-default + 1 unique claude model
      expect(data.length).toBe(2);
    });

    test("anthropic models have correct owned_by", async () => {
      const brainConfig = makeBrainConfig();
      const req = makeRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps({ brainConfig }));

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const data = body.data as Array<Record<string, unknown>>;
      const anthropicModels = data.filter((m) => m.id !== "eidolon-default" && m.owned_by === "anthropic");
      expect(anthropicModels.length).toBeGreaterThan(0);
      for (const model of anthropicModels) {
        expect(model.owned_by).toBe("anthropic");
      }
    });

    test("includes security headers", async () => {
      const req = makeRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp?.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(resp?.headers.get("X-Frame-Options")).toBe("DENY");
      expect(resp?.headers.get("Content-Type")).toBe("application/json");
    });

    test("includes registered provider models", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      const router = makeRouter(provider);
      const req = makeRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps({ router }));

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const data = body.data as Array<Record<string, unknown>>;
      const ids = data.map((m) => m.id);
      expect(ids).toContain(provider.name);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: POST /v1/chat/completions (non-streaming)
  // ---------------------------------------------------------------------------

  describe("POST /v1/chat/completions", () => {
    test("returns completion from real LLM provider", async () => {
      const provider = FakeLLMProvider.withResponse("Hello from Eidolon!", "ollama");
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody(),
      });
      const resp = await handleOpenAIRequest(req, deps);
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(200);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.object).toBe("chat.completion");
      expect(typeof body.id).toBe("string");
      expect((body.id as string).startsWith("chatcmpl-")).toBe(true);
      expect(typeof body.created).toBe("number");

      const choices = body.choices as Array<Record<string, unknown>>;
      expect(choices.length).toBe(1);
      expect(choices[0]?.index).toBe(0);
      expect(choices[0]?.finish_reason).toBe("stop");

      const message = choices[0]?.message as Record<string, unknown>;
      expect(message.role).toBe("assistant");
      expect(message.content).toBe("Hello from Eidolon!");

      const usage = body.usage as Record<string, unknown>;
      expect(typeof usage.prompt_tokens).toBe("number");
      expect(typeof usage.completion_tokens).toBe("number");
      expect(typeof usage.total_tokens).toBe("number");
      expect(usage.total_tokens).toBe((usage.prompt_tokens as number) + (usage.completion_tokens as number));
    });

    test("passes messages to the provider", async () => {
      const provider = FakeLLMProvider.withResponse("Response", "ollama");
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ messages: [{ role: "user", content: "Test message" }] }),
      });
      await handleOpenAIRequest(req, deps);

      const calls = provider.getCalls();
      expect(calls.length).toBe(1);
      expect(calls[0]?.messages[0]?.role).toBe("user");
      expect(calls[0]?.messages[0]?.content).toBe("Test message");
    });

    test("resolves eidolon-default model via brain config", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      const brainConfig = makeBrainConfig({ default: "claude-sonnet-4-20250514" });
      const deps = makeDeps({ router: makeRouter(provider), brainConfig });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ model: "eidolon-default" }),
      });
      const resp = await handleOpenAIRequest(req, deps);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.model).toBe("claude-sonnet-4-20250514");
    });

    test("maps OpenAI model names to Eidolon equivalents", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ model: "gpt-4o" }),
      });
      const resp = await handleOpenAIRequest(req, deps);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.model).toBe("claude-sonnet-4-20250514");
    });

    test("passes through unknown model names unchanged", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ model: "my-custom-model" }),
      });
      const resp = await handleOpenAIRequest(req, deps);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.model).toBe("my-custom-model");
    });

    test("returns error for invalid JSON body", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(400);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.type).toBe("invalid_request_error");
      expect(error.code).toBe("invalid_json");
    });

    test("returns validation error for missing model", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(400);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe("invalid_params");
      expect(error.message as string).toContain("model");
    });

    test("returns validation error for empty messages array", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "test", messages: [] }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(400);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe("invalid_params");
    });

    test("returns validation error for invalid message role", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "test",
          messages: [{ role: "unknown_role", content: "hi" }],
        }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp?.status).toBe(400);
    });

    test("returns validation error for temperature out of range", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ temperature: 3.0 }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp?.status).toBe(400);
    });

    test("returns 503 when no provider is available", async () => {
      const deps = makeDeps({ router: makeRouter() }); // no provider registered

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody(),
      });
      const resp = await handleOpenAIRequest(req, deps);
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(503);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.code).toBe("no_provider");
    });

    test("returns 503 when no router is configured", async () => {
      const deps = makeDeps({ router: undefined });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody(),
      });
      const resp = await handleOpenAIRequest(req, deps);
      expect(resp?.status).toBe(503);
    });

    test("returns token usage from provider", async () => {
      const provider = new FakeLLMProvider("ollama");
      // The default completion response has inputTokens: 10, outputTokens: 5
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody(),
      });
      const resp = await handleOpenAIRequest(req, deps);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const usage = body.usage as Record<string, unknown>;
      expect(usage.prompt_tokens).toBe(10);
      expect(usage.completion_tokens).toBe(5);
      expect(usage.total_tokens).toBe(15);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: POST /v1/chat/completions (streaming)
  // ---------------------------------------------------------------------------

  describe("POST /v1/chat/completions (streaming)", () => {
    test("returns SSE response with correct content type", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp?.status).toBe(200);
      expect(resp?.headers.get("Content-Type")).toBe("text/event-stream");
    });

    test("streams valid SSE chunks ending with [DONE]", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      provider.setStreamEvents([
        { type: "text", text: "Hello " },
        { type: "text", text: "world!" },
        { type: "done", usage: { inputTokens: 10, outputTokens: 5 } },
      ]);
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, deps);
      expect(resp).not.toBeNull();

      const text = (await resp?.text()) ?? "";
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));

      // 2 text chunks + 1 done chunk + 1 [DONE] sentinel
      expect(lines.length).toBe(4);

      // Last data line should be [DONE]
      expect(lines[lines.length - 1]).toBe("data: [DONE]");

      // Content lines should be parseable JSON
      const jsonLines = lines.slice(0, -1);
      for (const line of jsonLines) {
        const payload = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
        expect(payload.object).toBe("chat.completion.chunk");
        expect(typeof payload.id).toBe("string");
        expect((payload.id as string).startsWith("chatcmpl-")).toBe(true);
      }
    });

    test("final content chunk has finish_reason stop", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      provider.setStreamEvents([
        { type: "text", text: "Hi" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 1 } },
      ]);
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, deps);
      const text = (await resp?.text()) ?? "";
      const lines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

      // Last JSON chunk should have finish_reason: "stop"
      const lastChunk = JSON.parse(lines[lines.length - 1]?.slice("data: ".length) ?? "{}") as Record<string, unknown>;
      const choices = lastChunk.choices as Array<Record<string, unknown>>;
      expect(choices[0]?.finish_reason).toBe("stop");
    });

    test("content chunks have delta.content with text from provider", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      provider.setStreamEvents([
        { type: "text", text: "Alpha " },
        { type: "text", text: "Beta" },
        { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
      ]);
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, deps);
      const text = (await resp?.text()) ?? "";
      const lines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

      // Content chunks are all but the last (which has finish_reason: stop)
      const contentChunks = lines.slice(0, -1);
      let concatenated = "";
      for (const line of contentChunks) {
        const payload = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
        const choices = payload.choices as Array<Record<string, unknown>>;
        const delta = choices[0]?.delta as Record<string, unknown>;
        expect(typeof delta.content).toBe("string");
        concatenated += delta.content as string;
      }

      expect(concatenated).toBe("Alpha Beta");
    });

    test("all chunks share the same completion ID", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      const text = (await resp?.text()) ?? "";
      const lines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

      const ids = new Set<string>();
      for (const line of lines) {
        const payload = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
        ids.add(payload.id as string);
      }

      expect(ids.size).toBe(1);
    });

    test("includes usage in the final done chunk", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      provider.setStreamEvents([
        { type: "text", text: "Hi" },
        { type: "done", usage: { inputTokens: 42, outputTokens: 7 } },
      ]);
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, deps);
      const text = (await resp?.text()) ?? "";
      const lines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

      // The last JSON chunk (finish_reason: stop) should have usage
      const lastChunk = JSON.parse(lines[lines.length - 1]?.slice("data: ".length) ?? "{}") as Record<string, unknown>;
      const usage = lastChunk.usage as Record<string, unknown> | undefined;
      expect(usage).toBeDefined();
      expect(usage?.prompt_tokens).toBe(42);
      expect(usage?.completion_tokens).toBe(7);
      expect(usage?.total_tokens).toBe(49);
    });

    test("returns 503 when no provider is available for streaming", async () => {
      const deps = makeDeps({ router: makeRouter() });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, deps);
      expect(resp?.status).toBe(503);
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Security headers
  // ---------------------------------------------------------------------------

  describe("security headers", () => {
    test("error responses include security headers", async () => {
      const req = makeRequest("/v1/unknown");
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp?.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(resp?.headers.get("X-Frame-Options")).toBe("DENY");
      expect(resp?.headers.get("Cache-Control")).toBe("no-store");
    });

    test("streaming response includes security headers", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp?.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(resp?.headers.get("X-Frame-Options")).toBe("DENY");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: Model name mapping
  // ---------------------------------------------------------------------------

  describe("model name mapping", () => {
    test("maps gpt-4 to claude-opus", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ model: "gpt-4" }),
      });
      const resp = await handleOpenAIRequest(req, deps);
      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.model).toBe("claude-opus-4-20250514");
    });

    test("maps gpt-3.5-turbo to claude-haiku", async () => {
      const provider = FakeLLMProvider.withResponse("test", "ollama");
      const deps = makeDeps({ router: makeRouter(provider) });

      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ model: "gpt-3.5-turbo" }),
      });
      const resp = await handleOpenAIRequest(req, deps);
      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.model).toBe("claude-haiku-3-20250414");
    });
  });
});
