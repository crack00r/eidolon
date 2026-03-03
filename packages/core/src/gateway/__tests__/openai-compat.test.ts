import { describe, expect, test } from "bun:test";
import type { BrainConfig } from "@eidolon/protocol";
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

function makeDeps(overrides?: Partial<OpenAICompatDeps>): OpenAICompatDeps {
  return {
    logger,
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
      expect(resp!.status).toBe(404);

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
    test("allows requests when no authToken is configured", async () => {
      const req = makeRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe(200);
    });

    test("allows requests with valid Bearer token", async () => {
      const req = makeAuthRequest("/v1/models", "my-secret");
      const resp = await handleOpenAIRequest(req, makeDeps({ authToken: "my-secret" }));
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe(200);
    });

    test("rejects requests with missing Authorization header", async () => {
      const req = makeRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps({ authToken: "my-secret" }));
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe(401);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const error = body.error as Record<string, unknown>;
      expect(error.type).toBe("authentication_error");
      expect(error.code).toBe("invalid_api_key");
    });

    test("rejects requests with wrong token", async () => {
      const req = makeAuthRequest("/v1/models", "wrong-token");
      const resp = await handleOpenAIRequest(req, makeDeps({ authToken: "correct-token" }));
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe(401);
    });

    test("rejects requests with malformed Authorization header", async () => {
      const req = new Request("http://localhost:8419/v1/models", {
        headers: { Authorization: "Basic abc123" },
      });
      const resp = await handleOpenAIRequest(req, makeDeps({ authToken: "my-secret" }));
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe(401);
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
      expect(resp!.status).toBe(200);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.object).toBe("list");

      const data = body.data as Array<Record<string, unknown>>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data[0]!.id).toBe("eidolon-default");
      expect(data[0]!.object).toBe("model");
      expect(typeof data[0]!.created).toBe("number");
      expect(data[0]!.owned_by).toBe("eidolon");
    });

    test("includes brain config models when provided", async () => {
      const brainConfig = makeBrainConfig();
      const req = makeRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps({ brainConfig }));
      expect(resp).not.toBeNull();

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const data = body.data as Array<Record<string, unknown>>;

      // eidolon-default + 3 unique claude models
      expect(data.length).toBe(4);

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
      const resp = await handleOpenAIRequest(req, makeDeps({ brainConfig }));

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
      const anthropicModels = data.filter((m) => m.id !== "eidolon-default");
      for (const model of anthropicModels) {
        expect(model.owned_by).toBe("anthropic");
      }
    });

    test("includes security headers", async () => {
      const req = makeRequest("/v1/models");
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp!.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(resp!.headers.get("X-Frame-Options")).toBe("DENY");
      expect(resp!.headers.get("Content-Type")).toBe("application/json");
    });
  });

  // ---------------------------------------------------------------------------
  // Tests: POST /v1/chat/completions (non-streaming)
  // ---------------------------------------------------------------------------

  describe("POST /v1/chat/completions", () => {
    test("returns valid completion response", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody(),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe(200);

      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.object).toBe("chat.completion");
      expect(typeof body.id).toBe("string");
      expect((body.id as string).startsWith("chatcmpl-")).toBe(true);
      expect(body.model).toBe("eidolon-default");
      expect(typeof body.created).toBe("number");

      const choices = body.choices as Array<Record<string, unknown>>;
      expect(choices.length).toBe(1);
      expect(choices[0]!.index).toBe(0);
      expect(choices[0]!.finish_reason).toBe("stop");

      const message = choices[0]!.message as Record<string, unknown>;
      expect(message.role).toBe("assistant");
      expect(typeof message.content).toBe("string");
      expect((message.content as string).length).toBeGreaterThan(0);

      const usage = body.usage as Record<string, unknown>;
      expect(typeof usage.prompt_tokens).toBe("number");
      expect(typeof usage.completion_tokens).toBe("number");
      expect(typeof usage.total_tokens).toBe("number");
      expect(usage.total_tokens).toBe((usage.prompt_tokens as number) + (usage.completion_tokens as number));
    });

    test("includes the user message content in the stub response", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ messages: [{ role: "user", content: "Test message" }] }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      const choices = body.choices as Array<Record<string, unknown>>;
      const message = choices[0]!.message as Record<string, unknown>;
      expect(message.content as string).toContain("12 chars");
    });

    test("reflects the requested model in the response", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ model: "claude-opus-4-20250514" }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      const body = (await parseJsonBody(resp!)) as Record<string, unknown>;
      expect(body.model).toBe("claude-opus-4-20250514");
    });

    test("returns error for invalid JSON body", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not json",
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp!.status).toBe(400);

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
      expect(resp!.status).toBe(400);

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
      expect(resp!.status).toBe(400);

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
      expect(resp!.status).toBe(400);
    });

    test("returns validation error for temperature out of range", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ temperature: 3.0 }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp!.status).toBe(400);
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
      expect(resp!.status).toBe(200);
      expect(resp!.headers.get("Content-Type")).toBe("text/event-stream");
    });

    test("streams valid SSE chunks ending with [DONE]", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();

      const text = await resp!.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: "));

      expect(lines.length).toBeGreaterThan(2);

      // Last data line should be [DONE]
      expect(lines[lines.length - 1]).toBe("data: [DONE]");

      // All other lines should be parseable JSON
      const jsonLines = lines.slice(0, -1);
      for (const line of jsonLines) {
        const payload = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
        expect(payload.object).toBe("chat.completion.chunk");
        expect(typeof payload.id).toBe("string");
        expect((payload.id as string).startsWith("chatcmpl-")).toBe(true);
        expect(payload.model).toBe("eidolon-default");

        const choices = payload.choices as Array<Record<string, unknown>>;
        expect(choices.length).toBe(1);
        expect(choices[0]!.index).toBe(0);
      }
    });

    test("final content chunk has finish_reason stop", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      const text = await resp!.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

      // Last JSON chunk should have finish_reason: "stop"
      const lastChunk = JSON.parse(lines[lines.length - 1]!.slice("data: ".length)) as Record<string, unknown>;
      const choices = lastChunk.choices as Array<Record<string, unknown>>;
      expect(choices[0]!.finish_reason).toBe("stop");
    });

    test("content chunks have delta.content with text", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      const text = await resp!.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

      // All but last should have content in delta
      const contentChunks = lines.slice(0, -1);
      let concatenated = "";
      for (const line of contentChunks) {
        const payload = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
        const choices = payload.choices as Array<Record<string, unknown>>;
        const delta = choices[0]!.delta as Record<string, unknown>;
        expect(typeof delta.content).toBe("string");
        concatenated += delta.content as string;
      }

      // The concatenated content should form the full response
      expect(concatenated).toContain("[Eidolon]");
      expect(concatenated).toContain("stub response");
    });

    test("all chunks share the same completion ID", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      const text = await resp!.text();
      const lines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");

      const ids = new Set<string>();
      for (const line of lines) {
        const payload = JSON.parse(line.slice("data: ".length)) as Record<string, unknown>;
        ids.add(payload.id as string);
      }

      expect(ids.size).toBe(1);
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
      expect(resp!.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(resp!.headers.get("X-Frame-Options")).toBe("DENY");
      expect(resp!.headers.get("Cache-Control")).toBe("no-store");
    });

    test("streaming response includes security headers", async () => {
      const req = makeRequest("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: makeChatBody({ stream: true }),
      });
      const resp = await handleOpenAIRequest(req, makeDeps());
      expect(resp).not.toBeNull();
      expect(resp!.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(resp!.headers.get("X-Frame-Options")).toBe("DENY");
    });
  });
});
