/**
 * Client authentication logic -- extracted from client-manager.ts.
 *
 * Handles token-based auth for WebSocket clients, supporting both
 * legacy token format and JSON-RPC auth.authenticate method.
 */

import type { EventBus } from "../loop/event-bus.ts";
import type { Logger } from "../logging/logger.ts";
import {
  createJsonRpcError,
  createJsonRpcResponse,
} from "./protocol.ts";
import type { AuthRateLimiter } from "./rate-limiter.ts";
import {
  anonymizeIp,
  type ClientState,
  constantTimeCompare,
  type ServerWS,
} from "./server-helpers.ts";

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
    emitAuthFailure(ws, client, "Invalid auth payload", deps);
    return;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    emitAuthFailure(ws, client, "Invalid auth payload", deps);
    return;
  }

  const obj = parsed as Record<string, unknown>;
  const isJsonRpc = obj.jsonrpc === "2.0" && typeof obj.method === "string";
  let token: string | undefined;
  let jsonRpcId: string | undefined;

  if (isJsonRpc) {
    if (obj.method !== "auth.authenticate") {
      emitAuthFailure(ws, client, "Expected auth.authenticate method", deps, obj.id as string);
      return;
    }
    jsonRpcId = typeof obj.id === "string" ? obj.id : undefined;
    const params = obj.params as Record<string, unknown> | undefined;
    if (params && typeof params.token === "string") token = params.token;
  } else {
    if (obj.type !== "token" || typeof obj.token !== "string") {
      emitAuthFailure(ws, client, "Invalid auth: expected { type: 'token', token: string }", deps);
      return;
    }
    token = obj.token;
  }

  if (typeof token !== "string") {
    emitAuthFailure(ws, client, "Missing token in auth payload", deps, jsonRpcId);
    return;
  }

  const authConfig = deps.getAuthConfig();
  const configToken = authConfig.token;
  if (typeof configToken !== "string" || !constantTimeCompare(token, configToken)) {
    deps.rateLimiter.recordFailure(client.ip);
    emitAuthFailure(ws, client, "Authentication failed", deps, jsonRpcId);
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
    const params = obj.params as Record<string, unknown> | undefined;
    if (params) {
      if (typeof params.platform === "string") client.platform = params.platform;
      if (typeof params.version === "string") client.version = params.version;
    }
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
    ws.send(JSON.stringify(response));
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
): void {
  deps.logger.warn("auth-failure", `Auth failed for client ${client.id}: ${reason}`, {
    ip: anonymizeIp(client.ip),
  });
  const genericMessage = "Authentication failed";
  if (jsonRpcId) {
    const errResp = createJsonRpcError(jsonRpcId, -32000, genericMessage);
    ws.send(JSON.stringify(errResp));
  }
  ws.close(4001, genericMessage);
  deps.eventBus.publish(
    "gateway:client_connected",
    { clientId: client.id, authenticated: false },
    { source: "gateway" },
  );
}
