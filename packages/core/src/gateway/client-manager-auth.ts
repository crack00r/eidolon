/**
 * Client authentication logic -- extracted from client-manager.ts.
 *
 * Handles token-based auth for WebSocket clients, supporting both
 * legacy token format and JSON-RPC auth.authenticate method.
 */

import { z } from "zod";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import { createJsonRpcError, createJsonRpcResponse } from "./protocol.ts";
import type { AuthRateLimiter } from "./rate-limiter.ts";
import { anonymizeIp, type ClientState, constantTimeCompare, type ServerWS } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// Auth payload schemas
// ---------------------------------------------------------------------------

/** JSON-RPC auth.authenticate request. */
const JsonRpcAuthSchema = z.object({
  jsonrpc: z.literal("2.0"),
  method: z.literal("auth.authenticate"),
  id: z.string().optional(),
  params: z
    .object({
      token: z.string(),
      platform: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
});

/** Legacy token-based auth message. */
const LegacyAuthSchema = z.object({
  type: z.literal("token"),
  token: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthDeps {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly rateLimiter: AuthRateLimiter;
  readonly getAuthConfig: () => { type: string; token?: string | Record<string, unknown> };
  readonly pushToSubscribers: (type: "push.clientConnected", data: Record<string, unknown>) => void;
}

// ---------------------------------------------------------------------------
// Auth handler
// ---------------------------------------------------------------------------

/** Handle an authentication attempt from an unauthenticated client. */
export function handleClientAuth(
  ws: ServerWS,
  client: ClientState,
  text: string,
  deps: AuthDeps,
  authTimers: Map<string, ReturnType<typeof setTimeout>>,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Intentional: invalid JSON in auth payload is an auth failure
    emitAuthFailure(ws, client, "Invalid auth payload", deps, undefined, authTimers);
    return;
  }

  // Try JSON-RPC auth schema first, then legacy token schema
  const jsonRpcResult = JsonRpcAuthSchema.safeParse(parsed);
  const legacyResult = !jsonRpcResult.success ? LegacyAuthSchema.safeParse(parsed) : undefined;

  let token: string | undefined;
  let jsonRpcId: string | undefined;
  let isJsonRpc = false;
  let platform: string | undefined;
  let version: string | undefined;

  if (jsonRpcResult.success) {
    isJsonRpc = true;
    const data = jsonRpcResult.data;
    jsonRpcId = data.id;
    token = data.params?.token;
    platform = data.params?.platform;
    version = data.params?.version;
  } else if (legacyResult?.success) {
    token = legacyResult.data.token;
  } else {
    emitAuthFailure(
      ws,
      client,
      "Invalid auth payload: expected JSON-RPC auth.authenticate or { type: 'token', token: string }",
      deps,
      undefined,
      authTimers,
    );
    return;
  }

  if (typeof token !== "string") {
    emitAuthFailure(ws, client, "Missing token in auth payload", deps, jsonRpcId, authTimers);
    return;
  }

  const authConfig = deps.getAuthConfig();
  const configToken = authConfig.token;
  if (typeof configToken !== "string" || !constantTimeCompare(token, configToken)) {
    deps.rateLimiter.recordFailure(client.ip);
    emitAuthFailure(ws, client, "Authentication failed", deps, jsonRpcId, authTimers);
    return;
  }

  deps.rateLimiter.recordSuccess(client.ip);
  client.authenticated = true;

  const authTimer = authTimers.get(client.id);
  if (authTimer) {
    clearTimeout(authTimer);
    authTimers.delete(client.id);
  }

  if (isJsonRpc) {
    if (platform) client.platform = platform;
    if (version) client.version = version;
  }

  deps.logger.info("auth", `Client ${client.id} authenticated from ${anonymizeIp(client.ip)}`);
  deps.eventBus.publish(
    "gateway:client_connected",
    { clientId: client.id, authenticated: true },
    { source: "gateway" },
  );
  deps.pushToSubscribers("push.clientConnected", {
    clientId: client.id,
    platform: client.platform,
    version: client.version,
    timestamp: client.connectedAt,
  });

  if (isJsonRpc && jsonRpcId) {
    const response = createJsonRpcResponse(jsonRpcId, { authenticated: true });
    try {
      ws.send(JSON.stringify(response));
    } catch {
      // Client may have already disconnected
    }
  }
}

// ---------------------------------------------------------------------------
// Auth failure
// ---------------------------------------------------------------------------

export function emitAuthFailure(
  ws: ServerWS,
  client: ClientState,
  reason: string,
  deps: AuthDeps,
  jsonRpcId?: string,
  authTimers?: Map<string, ReturnType<typeof setTimeout>>,
): void {
  // Clear the auth timer on failure to prevent lingering timers
  if (authTimers) {
    const timer = authTimers.get(client.id);
    if (timer) {
      clearTimeout(timer);
      authTimers.delete(client.id);
    }
  }

  deps.logger.warn("auth-failure", `Auth failed for client ${client.id}: ${reason}`, {
    ip: anonymizeIp(client.ip),
  });
  const genericMessage = "Authentication failed";
  if (jsonRpcId) {
    const errResp = createJsonRpcError(jsonRpcId, -32000, genericMessage);
    try {
      ws.send(JSON.stringify(errResp));
    } catch {
      // Client may have already disconnected
    }
  }
  ws.close(4001, genericMessage);
  deps.eventBus.publish(
    "gateway:client_connected",
    { clientId: client.id, authenticated: false },
    { source: "gateway" },
  );
}
