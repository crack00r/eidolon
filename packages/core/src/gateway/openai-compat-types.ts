/**
 * OpenAI-compatible REST API types and response helpers.
 *
 * Extracted from openai-compat.ts to keep file sizes manageable.
 */

import type { BrainConfig } from "@eidolon/protocol";
import type { ModelRouter } from "../llm/router.ts";
import { SECURITY_HEADERS, constantTimeCompare } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// OpenAI-format response types
// ---------------------------------------------------------------------------

export interface OpenAIModel {
  readonly id: string;
  readonly object: "model";
  readonly created: number;
  readonly owned_by: string;
}

export interface OpenAIModelsResponse {
  readonly object: "list";
  readonly data: readonly OpenAIModel[];
}

export interface OpenAIUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface OpenAIChatCompletionResponse {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly {
    readonly index: number;
    readonly message: { readonly role: "assistant"; readonly content: string };
    readonly finish_reason: "stop" | "length";
  }[];
  readonly usage: OpenAIUsage;
}

export interface OpenAIErrorBody {
  readonly error: {
    readonly message: string;
    readonly type: string;
    readonly code: string | null;
  };
}

// Re-export SECURITY_HEADERS from server-helpers for backward compatibility
export { SECURITY_HEADERS } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "application/json" },
  });
}

export function openAIError(message: string, type: string, code: string | null, status: number): Response {
  const body: OpenAIErrorBody = { error: { message, type, code } };
  return jsonResponse(body, status);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

export function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.get("Authorization");
  if (!header) return undefined;
  const parts = header.split(" ");
  if (parts.length === 2 && parts[0] === "Bearer") return parts[1];
  return undefined;
}

export function checkAuth(req: Request, expectedToken: string | undefined): Response | null {
  if (!expectedToken) {
    return openAIError("API authentication not configured", "server_error", "auth_not_configured", 503);
  }
  const provided = extractBearerToken(req);
  if (!provided || !constantTimeCompare(provided, expectedToken)) {
    return openAIError("Invalid or missing authentication token", "authentication_error", "invalid_api_key", 401);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Model list builder
// ---------------------------------------------------------------------------

export function buildModelList(brainConfig?: BrainConfig, router?: ModelRouter): OpenAIModelsResponse {
  const now = Math.floor(Date.now() / 1000);
  const models: OpenAIModel[] = [{ id: "eidolon-default", object: "model", created: now, owned_by: "eidolon" }];
  const seen = new Set<string>(["eidolon-default"]);

  if (brainConfig) {
    for (const id of [brainConfig.model.default, brainConfig.model.complex, brainConfig.model.fast]) {
      if (!seen.has(id)) {
        seen.add(id);
        models.push({ id, object: "model", created: now, owned_by: "anthropic" });
      }
    }
  }

  // Include models from registered LLM providers
  if (router) {
    for (const provider of router.getAllProviders()) {
      const ownedBy = provider.type === "claude" ? "anthropic" : provider.type;
      if (!seen.has(provider.name)) {
        seen.add(provider.name);
        models.push({ id: provider.name, object: "model", created: now, owned_by: ownedBy });
      }
    }
  }

  return { object: "list", data: models };
}
