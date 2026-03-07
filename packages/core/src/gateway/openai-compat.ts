/**
 * OpenAI-compatible REST API layer for the Eidolon gateway.
 *
 * Provides `/v1/models` and `/v1/chat/completions` endpoints that follow the
 * OpenAI API specification, enabling any OpenAI-compatible tool (Jan, Open WebUI,
 * LM Studio, custom scripts) to use Eidolon as a backend.
 *
 * Chat completions are routed through the LLM router when available, falling
 * back to a "no provider" error when no providers are registered.
 *
 * Authentication uses the same gateway token as WebSocket connections via
 * the `Authorization: Bearer <token>` header.
 */

import { randomUUID } from "node:crypto";
import type { BrainConfig, ILLMProvider, LLMMessage } from "@eidolon/protocol";
import { z } from "zod";
import type { ModelRouter } from "../llm/router.ts";
import type { Logger } from "../logging/logger.ts";
import type { OpenAIChatCompletionResponse } from "./openai-compat-types.ts";
import { buildModelList, checkAuth, jsonResponse, openAIError, SECURITY_HEADERS } from "./openai-compat-types.ts";

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
// Dependencies
// ---------------------------------------------------------------------------

export interface OpenAICompatDeps {
  readonly logger: Logger;
  readonly brainConfig?: BrainConfig;
  readonly authToken?: string;
  /** LLM router for dispatching completions to real providers. */
  readonly router?: ModelRouter;
}

// ---------------------------------------------------------------------------
// OpenAI model name -> Eidolon model mapping
// ---------------------------------------------------------------------------

/** Map well-known OpenAI model names to Eidolon equivalents. */
const OPENAI_MODEL_MAP: Readonly<Record<string, string>> = {
  "gpt-4": "claude-opus-4-20250514",
  "gpt-4-turbo": "claude-opus-4-20250514",
  "gpt-4o": "claude-sonnet-4-20250514",
  "gpt-4o-mini": "claude-haiku-3-20250414",
  "gpt-3.5-turbo": "claude-haiku-3-20250414",
};

function resolveModel(requestedModel: string, brainConfig?: BrainConfig): string {
  if (requestedModel === "eidolon-default") {
    return brainConfig?.model.default ?? "claude-sonnet-4-20250514";
  }
  return OPENAI_MODEL_MAP[requestedModel] ?? requestedModel;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert OpenAI chat messages to LLM provider messages. */
function toLLMMessages(messages: ChatCompletionRequest["messages"]): LLMMessage[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

/** Find the first available provider from the router for a conversation task. */
async function findProvider(router: ModelRouter | undefined, _log: Logger): Promise<ILLMProvider | undefined> {
  if (!router) return undefined;
  return router.selectProvider({ type: "conversation" });
}

// ---------------------------------------------------------------------------
// Non-streaming completion via real provider
// ---------------------------------------------------------------------------

async function executeCompletion(
  request: ChatCompletionRequest,
  provider: ILLMProvider,
  resolvedModel: string,
  log: Logger,
): Promise<Response> {
  try {
    const result = await provider.complete(toLLMMessages(request.messages), {
      model: resolvedModel,
      temperature: request.temperature,
      maxTokens: request.max_tokens,
    });

    const finishReason = result.finishReason === "max_tokens" ? ("length" as const) : ("stop" as const);

    const response: OpenAIChatCompletionResponse = {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: resolvedModel,
      choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: finishReason }],
      usage: {
        prompt_tokens: result.usage.inputTokens,
        completion_tokens: result.usage.outputTokens,
        total_tokens: result.usage.inputTokens + result.usage.outputTokens,
      },
    };

    return jsonResponse(response, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown provider error";
    log.error("chat", "Completion failed", err instanceof Error ? err : undefined, { model: resolvedModel });
    return openAIError(`Provider error: ${message}`, "server_error", "provider_error", 502);
  }
}

// ---------------------------------------------------------------------------
// Streaming completion via real provider
// ---------------------------------------------------------------------------

function executeStreamingCompletion(
  request: ChatCompletionRequest,
  provider: ILLMProvider,
  resolvedModel: string,
  log: Logger,
): Response {
  const completionId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller): Promise<void> {
      try {
        let _totalText = "";
        const streamIter = provider.stream(toLLMMessages(request.messages), {
          model: resolvedModel,
          temperature: request.temperature,
          maxTokens: request.max_tokens,
        });

        for await (const event of streamIter) {
          if (event.type === "text" && event.text) {
            _totalText += event.text;
            const chunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: resolvedModel,
              choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } else if (event.type === "done") {
            const finalChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: resolvedModel,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              ...(event.usage
                ? {
                    usage: {
                      prompt_tokens: event.usage.inputTokens,
                      completion_tokens: event.usage.outputTokens,
                      total_tokens: event.usage.inputTokens + event.usage.outputTokens,
                    },
                  }
                : {}),
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } else if (event.type === "error") {
            log.error("chat", `Stream error: ${event.error ?? "unknown"}`);
            const errorChunk = {
              id: completionId,
              object: "chat.completion.chunk",
              created,
              model: resolvedModel,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown stream error";
        log.error("chat", `Stream failed: ${message}`);
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        } catch {
          // Controller may already be closed
        }
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
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
 * Returns `null` if the request path does not match any `/v1/` route.
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
    return jsonResponse(buildModelList(deps.brainConfig, deps.router), 200);
  }

  // POST /v1/chat/completions
  if (path === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, log, deps);
  }

  // Unknown /v1/ endpoint
  return openAIError(`Unknown endpoint: ${req.method} ${path}`, "invalid_request_error", "not_found", 404);
}

// ---------------------------------------------------------------------------
// Chat completions sub-handler
// ---------------------------------------------------------------------------

async function handleChatCompletions(req: Request, log: Logger, deps: OpenAICompatDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    // Intentional: malformed JSON returns OpenAI-compatible error
    return openAIError("Invalid JSON in request body", "invalid_request_error", "invalid_json", 400);
  }

  const parsed = ChatCompletionRequestSchema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return openAIError(`Validation error: ${issues}`, "invalid_request_error", "invalid_params", 400);
  }

  const request = parsed.data;
  const resolvedModel = resolveModel(request.model, deps.brainConfig);
  log.info(
    "chat",
    `Chat completion: model=${request.model} resolved=${resolvedModel} messages=${request.messages.length} stream=${String(request.stream)}`,
  );

  // Find a provider via the router
  const provider = await findProvider(deps.router, log);
  if (!provider) {
    return openAIError(
      "No LLM provider available. Configure at least one provider (Claude, Ollama, or llama.cpp) in your Eidolon config.",
      "server_error",
      "no_provider",
      503,
    );
  }

  if (request.stream) {
    return executeStreamingCompletion(request, provider, resolvedModel, log);
  }

  return executeCompletion(request, provider, resolvedModel, log);
}
