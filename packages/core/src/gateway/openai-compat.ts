/**
 * OpenAI-compatible REST API layer for the Eidolon gateway.
 *
 * Provides `/v1/models` and `/v1/chat/completions` endpoints that follow the
 * OpenAI API specification, enabling any OpenAI-compatible tool (Jan, Open WebUI,
 * LM Studio, custom scripts) to use Eidolon as a backend.
 *
 * Authentication uses the same gateway token as WebSocket connections via
 * the `Authorization: Bearer <token>` header.
 */

import { randomUUID } from "node:crypto";
import type { BrainConfig } from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Zod schemas for OpenAI request validation
// ---------------------------------------------------------------------------

const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(1_000_000),
});

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1).max(256),
  messages: z.array(ChatMessageSchema).min(1).max(1000),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(1_000_000).optional(),
});

type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

// ---------------------------------------------------------------------------
// OpenAI-format response types
// ---------------------------------------------------------------------------

interface OpenAIModel {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
}

interface OpenAIModelsResponse {
  readonly object: "list";
  readonly data: readonly OpenAIModel[];
}

interface OpenAIUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

interface OpenAIChatCompletionResponse {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly message: { readonly role: "assistant"; readonly content: string };
    readonly finish_reason: "stop";
  }[];
  readonly usage: OpenAIUsage;
}

interface OpenAIErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly code: string | null;
  };
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface OpenAICompatDeps {
  readonly logger: Logger;
  readonly brainConfig?: BrainConfig;
  readonly authToken?: string;
}

// ---------------------------------------------------------------------------
// Security headers (same set as the main gateway server)
// ---------------------------------------------------------------------------

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json" },
  });
}

function openAIError(message: string, type: string, code: string | null, status: number): Response {
  const body: OpenAIErrorBody = { error: { message, type, code } };
  return jsonResponse(body, status);
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.get("Authorization");
  if (!header) return undefined;
  const parts = header.split(" ");
  if (parts.length === 2 && parts[0] === "Bearer") return parts[1];
  return undefined;
}

function checkAuth(req: Request, expectedToken: string | undefined): Response | null {
  if (!expectedToken) return null;
  const provided = extractBearerToken(req);
  if (!provided || provided !== expectedToken) {
    return openAIError("Invalid or missing authentication token", "authentication_error", "invalid_api_key", 401);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model list builder
// ---------------------------------------------------------------------------

function buildModelList(brainConfig?: BrainConfig): OpenAIModelsResponse {
  const now = Math.floor(Date.now() / 1000);
  const models: OpenAIModel[] = [{ id: "eidolon-default", object: "model", created: now, owned_by: "eidolon" }];

  if (brainConfig) {
    const seen = new Set<string>();
    for (const id of [brainConfig.model.default, brainConfig.model.complex, brainConfig.model.fast]) {
      if (!seen.has(id)) {
        seen.add(id);
        models.push({ id, object: "model", created: now, owned_by: "anthropic" });
      }
    }
  }

  return { object: "list", data: models };
}

// ---------------------------------------------------------------------------
// Chat completion response builders
// ---------------------------------------------------------------------------

function buildCompletionResponse(request: ChatCompletionRequest): OpenAIChatCompletionResponse {
  const lastUserMsg = [...request.messages].reverse().find((m) => m.role === "user");
  const userText = lastUserMsg?.content ?? "";

  const responseText =
    `[Eidolon] Received your message (${userText.length} chars). ` +
    `Model: ${request.model}. This is a stub response -- ` +
    `Claude Code integration will provide real responses when sessions are wired.`;

  const promptTokens = request.messages.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
  const completionTokens = Math.ceil(responseText.length / 4);

  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ index: 0, message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function buildStreamingResponse(request: ChatCompletionRequest): Response {
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  const lastUserMsg = [...request.messages].reverse().find((m) => m.role === "user");
  const userText = lastUserMsg?.content ?? "";

  const responseText =
    `[Eidolon] Received your message (${userText.length} chars). ` +
    `Model: ${request.model}. This is a stub response -- ` +
    `Claude Code integration will provide real responses when sessions are wired.`;

  const CHUNK_SIZE = 20;
  const chunks: string[] = [];
  for (let i = 0; i < responseText.length; i += CHUNK_SIZE) {
    chunks.push(responseText.slice(i, i + CHUNK_SIZE));
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller): void {
      for (const chunk of chunks) {
        const event = {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: request.model,
          choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }

      const finalEvent = {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: request.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalEvent)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

/**
 * Handle an OpenAI-compatible REST API request.
 *
 * Routes:
 * - `GET  /v1/models`           -- List available models
 * - `POST /v1/chat/completions` -- Chat completions (streaming and non-streaming)
 *
 * Returns `null` if the request path does not match any `/v1/` route,
 * allowing the caller to fall through to other handlers (health, metrics, WS).
 */
export async function handleOpenAIRequest(req: Request, deps: OpenAICompatDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!path.startsWith("/v1/")) return null;

  const log = deps.logger.child("openai-compat");

  // Auth check
  const authErr = checkAuth(req, deps.authToken);
  if (authErr) {
    log.warn("auth", "Rejected OpenAI-compat request with invalid auth");
    return authErr;
  }

  // GET /v1/models
  if (path === "/v1/models" && req.method === "GET") {
    log.debug("models", "Listing models");
    return jsonResponse(buildModelList(deps.brainConfig), 200);
  }

  // POST /v1/chat/completions
  if (path === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, log);
  }

  // Unknown /v1/ endpoint
  return openAIError(`Unknown endpoint: ${req.method} ${path}`, "invalid_request_error", "not_found", 404);
}

// ---------------------------------------------------------------------------
// Chat completions sub-handler
// ---------------------------------------------------------------------------

async function handleChatCompletions(req: Request, log: Logger): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return openAIError("Invalid JSON in request body", "invalid_request_error", "invalid_json", 400);
  }

  const parsed = ChatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return openAIError(`Validation error: ${issues}`, "invalid_request_error", "invalid_params", 400);
  }

  const request = parsed.data;
  log.info(
    "chat",
    `Chat completion: model=${request.model} messages=${request.messages.length} stream=${String(request.stream)}`,
  );

  if (request.stream) {
    return buildStreamingResponse(request);
  }

  return jsonResponse(buildCompletionResponse(request), 200);
}
