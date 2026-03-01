/**
 * WebSocket Gateway Server using Bun's native WebSocket support.
 *
 * Desktop/iOS clients connect here to communicate with the Eidolon core
 * via JSON-RPC 2.0 over WebSocket.
 *
 * Security features:
 * - Constant-time token comparison (timing-safe)
 * - Dual auth format: raw ClientAuth + JSON-RPC wrapped
 * - TLS support (cert/key via Bun.serve)
 * - IP-based auth rate limiting with exponential backoff
 * - Connection limit enforcement
 * - Origin validation
 * - Max message payload size
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { GatewayConfig, GatewayMethod, GatewayPushEvent } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";
import type { EventBus } from "../loop/event-bus.js";
import {
  createJsonRpcError,
  createJsonRpcResponse,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_METHOD_NOT_FOUND,
  parseJsonRpcRequest,
} from "./protocol.js";
import { AuthRateLimiter } from "./rate-limiter.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MethodHandler = (params: Record<string, unknown>, clientId: string) => Promise<unknown>;

/** Minimal interface for the server-side WebSocket, matching Bun.ServerWebSocket. */
interface ServerWS {
  readonly data: WSData;
  send(data: string | ArrayBuffer | Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
}

interface ClientState {
  readonly id: string;
  readonly ip: string;
  readonly ws: ServerWS;
  authenticated: boolean;
}

interface WSData {
  clientId: string;
  ip: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison to prevent timing attacks on token validation.
 */
function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    // Compare bufA against itself to prevent timing leak on length difference
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// Export for testing
export { constantTimeCompare };

// ---------------------------------------------------------------------------
// GatewayServer
// ---------------------------------------------------------------------------

export class GatewayServer {
  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly rateLimiter: AuthRateLimiter;

  private readonly clients: Map<string, ClientState> = new Map();
  private readonly handlers: Map<GatewayMethod, MethodHandler> = new Map();
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(deps: { config: GatewayConfig; logger: Logger; eventBus: EventBus }) {
    this.config = deps.config;
    this.logger = deps.logger.child("gateway");
    this.eventBus = deps.eventBus;
    this.rateLimiter = new AuthRateLimiter(deps.config.rateLimiting, this.logger);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start listening on the configured host:port. */
  async start(): Promise<void> {
    if (this.server) {
      this.logger.warn("start", "Gateway server already running");
      return;
    }

    const { host, port } = this.config;
    const self = this;

    const tlsCert = this.config.tls.cert;
    const tlsKey = this.config.tls.key;
    const tlsConfig =
      this.config.tls.enabled && tlsCert && tlsKey
        ? {
            cert: Bun.file(tlsCert),
            key: Bun.file(tlsKey),
          }
        : undefined;

    this.server = Bun.serve<WSData>({
      port,
      hostname: host,
      ...(tlsConfig ? { tls: tlsConfig } : {}),

      fetch(req, server) {
        const url = new URL(req.url);

        if (url.pathname !== "/ws") {
          return new Response("Not found", { status: 404 });
        }

        // Extract client IP
        const ip = server.requestIP(req)?.address ?? "unknown";

        // Rate limiting check
        if (self.rateLimiter.isBlocked(ip)) {
          self.logger.warn("fetch", `Rate-limited IP ${ip} attempted connection`);
          return new Response("Too Many Requests", { status: 429 });
        }

        // Connection limit check
        if (self.clients.size >= self.config.maxClients) {
          self.logger.warn("fetch", `Connection limit reached (${self.config.maxClients}), rejecting ${ip}`);
          return new Response("Service Unavailable", { status: 503 });
        }

        // Origin validation
        if (self.config.allowedOrigins.length > 0) {
          const origin = req.headers.get("Origin") ?? "";
          if (!self.config.allowedOrigins.includes(origin)) {
            self.logger.warn("fetch", `Rejected origin "${origin}" from ${ip}`);
            return new Response("Forbidden", { status: 403 });
          }
        }

        const clientId = randomUUID();
        const upgraded = server.upgrade(req, { data: { clientId, ip } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined;
      },

      websocket: {
        maxPayloadLength: self.config.maxMessageBytes,
        open(ws) {
          self.handleOpen(ws);
        },
        message(ws, message) {
          void self.handleMessage(ws, message);
        },
        close(ws, code, reason) {
          self.handleClose(ws, code, reason);
        },
      },
    });

    const scheme = this.config.tls.enabled ? "wss" : "ws";
    this.logger.info("start", `Gateway server listening on ${scheme}://${host}:${port}`);
  }

  /** Graceful shutdown: close all connections and stop the server. */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    // Close all connected clients with 1001 (going away)
    for (const client of this.clients.values()) {
      try {
        client.ws.close(1001, "Server shutting down");
      } catch {
        // Client may already be disconnected
      }
    }
    this.clients.clear();

    this.server.stop(true);
    this.server = undefined;
    this.rateLimiter.dispose();
    this.logger.info("stop", "Gateway server stopped");
  }

  // -------------------------------------------------------------------------
  // Handler registration
  // -------------------------------------------------------------------------

  /** Register a handler for a specific JSON-RPC method. */
  registerHandler(method: GatewayMethod, handler: MethodHandler): void {
    this.handlers.set(method, handler);
    this.logger.debug("register", `Registered handler for ${method}`);
  }

  // -------------------------------------------------------------------------
  // Push events
  // -------------------------------------------------------------------------

  /** Broadcast a push event to all authenticated clients. */
  broadcast(event: GatewayPushEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients.values()) {
      if (client.authenticated) {
        try {
          client.ws.send(data);
        } catch {
          this.logger.warn("broadcast", `Failed to send to client ${client.id}`);
        }
      }
    }
  }

  /** Send a push event to a specific client by id. */
  sendTo(clientId: string, event: GatewayPushEvent): void {
    const client = this.clients.get(clientId);
    if (!client) {
      this.logger.warn("sendTo", `Client ${clientId} not found`);
      return;
    }
    try {
      client.ws.send(JSON.stringify(event));
    } catch {
      this.logger.warn("sendTo", `Failed to send to client ${clientId}`);
    }
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get connectedClients(): number {
    return this.clients.size;
  }

  get isRunning(): boolean {
    return this.server !== undefined;
  }

  // -------------------------------------------------------------------------
  // Internal WebSocket handlers
  // -------------------------------------------------------------------------

  private handleOpen(ws: ServerWS): void {
    const { clientId, ip } = ws.data;
    const requiresAuth = this.config.auth.type !== "none";

    const state: ClientState = {
      id: clientId,
      ip,
      ws,
      authenticated: !requiresAuth,
    };
    this.clients.set(clientId, state);

    if (!requiresAuth) {
      this.logger.info("open", `Client ${clientId} connected (auth: none)`);
      this.eventBus.publish("gateway:client_connected", { clientId, authenticated: true }, { source: "gateway" });
    } else {
      this.logger.info("open", `Client ${clientId} connected from ${ip}, awaiting auth`);
    }
  }

  private async handleMessage(ws: ServerWS, message: string | Buffer): Promise<void> {
    const clientId = ws.data.clientId;
    const client = this.clients.get(clientId);

    if (!client) {
      this.logger.warn("message", `Message from unknown client ${clientId}`);
      return;
    }

    const text = typeof message === "string" ? message : Buffer.from(message).toString("utf-8");

    // If not yet authenticated, expect ClientAuth as first message
    if (!client.authenticated) {
      this.handleAuth(ws, client, text);
      return;
    }

    // Parse JSON-RPC request
    const result = parseJsonRpcRequest(text);
    if (!result.ok) {
      ws.send(JSON.stringify(result.error));
      return;
    }

    const request = result.value;

    // Find handler
    const handler = this.handlers.get(request.method);
    if (!handler) {
      const errResp = createJsonRpcError(
        request.id,
        JSON_RPC_METHOD_NOT_FOUND,
        `No handler registered for ${request.method}`,
      );
      ws.send(JSON.stringify(errResp));
      return;
    }

    // Execute handler
    try {
      const handlerResult = await handler(request.params ?? {}, clientId);
      const response = createJsonRpcResponse(request.id, handlerResult);
      ws.send(JSON.stringify(response));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.error("handler", `Handler error for ${request.method}`, err);
      const errResp = createJsonRpcError(request.id, JSON_RPC_INTERNAL_ERROR, errorMessage);
      ws.send(JSON.stringify(errResp));
    }
  }

  private handleAuth(ws: ServerWS, client: ClientState, text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.emitAuthFailure(ws, client, "Invalid auth payload");
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.emitAuthFailure(ws, client, "Invalid auth payload");
      return;
    }

    const obj = parsed as Record<string, unknown>;

    // Detect format: JSON-RPC wrapped or raw ClientAuth
    const isJsonRpc = obj.jsonrpc === "2.0" && typeof obj.method === "string";
    let token: string | undefined;
    let jsonRpcId: string | undefined;

    if (isJsonRpc) {
      // JSON-RPC format: { jsonrpc: "2.0", id: "...", method: "auth.authenticate", params: { token: "..." } }
      if (obj.method !== "auth.authenticate") {
        this.emitAuthFailure(ws, client, "Expected auth.authenticate method", obj.id as string);
        return;
      }
      jsonRpcId = typeof obj.id === "string" ? obj.id : undefined;
      const params = obj.params as Record<string, unknown> | undefined;
      if (params && typeof params.token === "string") {
        token = params.token;
      }
    } else {
      // Raw ClientAuth format: { type: "token", token: "..." }
      if (obj.type !== "token" || typeof obj.token !== "string") {
        this.emitAuthFailure(ws, client, "Invalid auth: expected { type: 'token', token: string }");
        return;
      }
      token = obj.token;
    }

    if (typeof token !== "string") {
      this.emitAuthFailure(ws, client, "Missing token in auth payload", jsonRpcId);
      return;
    }

    // Resolve configured token
    const configToken = this.config.auth.token;
    if (typeof configToken !== "string" || !constantTimeCompare(token, configToken)) {
      this.rateLimiter.recordFailure(client.ip);
      this.emitAuthFailure(ws, client, "Authentication failed", jsonRpcId);
      return;
    }

    // Auth succeeded
    this.rateLimiter.recordSuccess(client.ip);
    client.authenticated = true;
    this.logger.info("auth", `Client ${client.id} authenticated from ${client.ip}`);
    this.eventBus.publish(
      "gateway:client_connected",
      { clientId: client.id, authenticated: true },
      { source: "gateway" },
    );

    // If JSON-RPC format, send a proper JSON-RPC response
    if (isJsonRpc && jsonRpcId) {
      const response = createJsonRpcResponse(jsonRpcId, { authenticated: true });
      ws.send(JSON.stringify(response));
    }
  }

  /**
   * Emit auth failure event and close the connection.
   * Optionally sends a JSON-RPC error response if a request ID is provided.
   */
  private emitAuthFailure(ws: ServerWS, client: ClientState, reason: string, jsonRpcId?: string): void {
    if (jsonRpcId) {
      const errResp = createJsonRpcError(jsonRpcId, -32000, reason);
      ws.send(JSON.stringify(errResp));
    }
    ws.close(4001, reason);
    this.eventBus.publish(
      "gateway:client_connected",
      { clientId: client.id, authenticated: false },
      { source: "gateway" },
    );
  }

  private handleClose(ws: ServerWS, _code: number, _reason: string): void {
    const clientId = ws.data.clientId;
    this.clients.delete(clientId);
    this.logger.info("close", `Client ${clientId} disconnected`);
    this.eventBus.publish("gateway:client_disconnected", { clientId }, { source: "gateway" });
  }
}
