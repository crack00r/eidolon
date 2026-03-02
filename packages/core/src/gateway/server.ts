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
  createPushEvent,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
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
 * When lengths differ, compare the secret (b) against itself to avoid leaking
 * attacker-controlled timing information while preserving constant-time behavior.
 */
function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    // Compare secret against itself (not attacker input) to prevent timing leak
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Normalize IP address: strip IPv4-mapped IPv6 prefix (::ffff:) to prevent bypass.
 */
function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

/**
 * Anonymize an IP address for GDPR-compliant logging.
 * IPv4: replace last octet with 0 (e.g., 192.168.1.42 -> 192.168.1.0)
 * IPv6: truncate last 80 bits (keep first 48 bits, zero the rest)
 */
function anonymizeIp(ip: string): string {
  // IPv4: a.b.c.d -> a.b.c.0
  if (ip.includes(".") && !ip.includes(":")) {
    const lastDot = ip.lastIndexOf(".");
    if (lastDot === -1) return ip;
    return `${ip.slice(0, lastDot)}.0`;
  }
  // IPv6: expand compressed form, keep first 3 groups (48 bits), zero the rest
  // Short addresses like "::1" have fewer than 3 non-empty groups — return as-is
  // since they don't contain personally identifiable information
  const nonEmptyParts = ip.split(":").filter((p) => p.length > 0);
  if (nonEmptyParts.length < 3) {
    return ip;
  }
  return `${nonEmptyParts.slice(0, 3).join(":")}::`;
}

/**
 * Normalize an origin string for comparison: lowercase and strip trailing slash.
 */
function normalizeOrigin(origin: string): string {
  return origin.toLowerCase().replace(/\/+$/, "");
}

/** Timeout in ms for unauthenticated clients before disconnection. */
const AUTH_TIMEOUT_MS = 10_000;

/** WebSocket idle timeout in seconds (Bun uses seconds for this). */
const WS_IDLE_TIMEOUT_SECONDS = 120;

/** Standard security headers applied to all HTTP responses from the gateway. */
const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
  "Cache-Control": "no-store",
  "Content-Type": "text/plain",
  "Content-Security-Policy": "default-src 'none'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

/** Create an HTTP Response with security headers, optionally adding HSTS for TLS. */
function secureResponse(body: string, status: number, tlsEnabled?: boolean): Response {
  const headers = { ...SECURITY_HEADERS };
  // Finding #11: Add HSTS header when TLS is enabled
  if (tlsEnabled) {
    headers["Strict-Transport-Security"] = "max-age=31536000";
  }
  return new Response(body, { status, headers });
}

// Export for testing
export { anonymizeIp, constantTimeCompare, normalizeIp, normalizeOrigin };

// ---------------------------------------------------------------------------
// RPC validation error (used to return -32602 instead of -32603)
// ---------------------------------------------------------------------------

class RpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcValidationError";
  }
}

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
  private readonly statusSubscribers: Set<string> = new Set();
  private broadcastFailureCount = 0;
  private startTime = 0;
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(deps: { config: GatewayConfig; logger: Logger; eventBus: EventBus }) {
    this.config = deps.config;
    this.logger = deps.logger.child("gateway");
    this.eventBus = deps.eventBus;
    this.rateLimiter = new AuthRateLimiter(deps.config.rateLimiting, this.logger);

    this.registerBuiltinHandlers();
  }

  // -------------------------------------------------------------------------
  // Built-in RPC handlers
  // -------------------------------------------------------------------------

  private registerBuiltinHandlers(): void {
    // error.report: clients report errors back to the server
    this.registerHandler("error.report", async (params, clientId) => {
      const errors = params.errors;
      const clientInfo = params.clientInfo;

      if (!Array.isArray(errors)) {
        throw new RpcValidationError("errors must be an array");
      }
      if (typeof clientInfo !== "object" || clientInfo === null) {
        throw new RpcValidationError("clientInfo must be an object");
      }

      const info = clientInfo as Record<string, unknown>;
      const platform = typeof info.platform === "string" ? info.platform : "unknown";
      const version = typeof info.version === "string" ? info.version : "unknown";

      for (const entry of errors) {
        if (typeof entry !== "object" || entry === null) continue;
        const e = entry as Record<string, unknown>;
        this.logger.warn(
          "client-error",
          `[${platform}@${version}] ${String(e.module ?? "unknown")}: ${String(e.message ?? "")}`,
          {
            clientId,
            level: String(e.level ?? "error"),
            timestamp: String(e.timestamp ?? ""),
            ...(e.data !== undefined ? { data: e.data as Record<string, unknown> } : {}),
          },
        );
      }

      this.eventBus.publish(
        "gateway:client_error_report",
        { clientId, platform, version, errorCount: errors.length },
        { source: "gateway" },
      );

      return { received: errors.length };
    });

    // system.status: return current system status skeleton
    this.registerHandler("system.status", async () => {
      const uptimeMs = this.server ? Date.now() - this.startTime : 0;
      return {
        state: "running",
        energy: { current: 0, max: 100 },
        activeTasks: 0,
        memoryCount: 0,
        uptime: uptimeMs,
        connectedClients: this.clients.size,
      };
    });

    // system.subscribe: subscribe to real-time status push updates
    this.registerHandler("system.subscribe", async (_params, clientId) => {
      this.statusSubscribers.add(clientId);
      this.logger.debug("subscribe", `Client ${clientId} subscribed to status updates`);
      return { subscribed: true };
    });
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
        const isTls = self.config.tls.enabled;

        if (url.pathname !== "/ws") {
          return secureResponse("Not found", 404, isTls);
        }

        // Extract client IP and normalize to prevent IPv6 bypass
        const ip = normalizeIp(server.requestIP(req)?.address ?? "unknown");
        const anonIp = anonymizeIp(ip);

        // Rate limiting check (uses real IP internally, logs anonymized)
        if (self.rateLimiter.isBlocked(ip)) {
          self.logger.warn("fetch", `Rate-limited IP ${anonIp} attempted connection`);
          return secureResponse("Too Many Requests", 429, isTls);
        }

        // Connection limit check
        if (self.clients.size >= self.config.maxClients) {
          self.logger.warn("fetch", `Connection limit reached (${self.config.maxClients}), rejecting ${anonIp}`);
          return secureResponse("Service Unavailable", 503, isTls);
        }

        // Origin validation (case-insensitive, trailing-slash-tolerant)
        if (self.config.allowedOrigins.length > 0) {
          const origin = normalizeOrigin(req.headers.get("Origin") ?? "");
          const allowed = self.config.allowedOrigins.some((o) => normalizeOrigin(o) === origin);
          if (!allowed) {
            self.logger.warn("fetch", `Rejected origin "${origin}" from ${anonIp}`);
            return secureResponse("Forbidden", 403, isTls);
          }
        }

        const clientId = randomUUID();
        const upgraded = server.upgrade(req, { data: { clientId, ip } });
        if (!upgraded) {
          return secureResponse("WebSocket upgrade failed", 400);
        }
        return undefined;
      },

      websocket: {
        maxPayloadLength: self.config.maxMessageBytes,
        idleTimeout: WS_IDLE_TIMEOUT_SECONDS,
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

    this.startTime = Date.now();
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
    let failures = 0;
    for (const client of this.clients.values()) {
      if (client.authenticated) {
        try {
          client.ws.send(data);
        } catch {
          failures++;
        }
      }
    }
    if (failures > 0) {
      this.broadcastFailureCount += failures;
      this.logger.warn("broadcast", `Failed to send to ${failures} client(s)`, {
        totalFailures: this.broadcastFailureCount,
      });
    }
  }

  /** Broadcast a status update to subscribed clients only. */
  broadcastStatus(status: Record<string, unknown>): void {
    if (this.statusSubscribers.size === 0) return;
    const event = createPushEvent("system.statusUpdate", status);
    const data = JSON.stringify(event);
    for (const clientId of this.statusSubscribers) {
      const client = this.clients.get(clientId);
      if (!client || !client.authenticated) {
        this.statusSubscribers.delete(clientId);
        continue;
      }
      try {
        client.ws.send(data);
      } catch {
        this.statusSubscribers.delete(clientId);
        this.logger.warn("broadcast-status", `Removed unreachable subscriber ${clientId}`);
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
    // Finding #14: Only send to authenticated clients
    if (!client.authenticated) return;
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
    const anonIp = anonymizeIp(ip);
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
      this.logger.info("open", `Client ${clientId} connected from ${anonIp}, awaiting auth`);

      // Enforce auth timeout: close unauthenticated connections
      setTimeout(() => {
        const client = this.clients.get(clientId);
        if (client && !client.authenticated) {
          this.logger.warn("auth-timeout", `Client ${clientId} auth timeout`, {
            ip: anonymizeIp(ip),
          });
          ws.close(4002, "Authentication timeout");
          this.clients.delete(clientId);
        }
      }, AUTH_TIMEOUT_MS);
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
      this.safeSend(ws, JSON.stringify(result.error));
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
      this.safeSend(ws, JSON.stringify(errResp));
      return;
    }

    // Execute handler
    try {
      const handlerResult = await handler(request.params ?? {}, clientId);
      const response = createJsonRpcResponse(request.id, handlerResult);
      this.safeSend(ws, JSON.stringify(response));
    } catch (err) {
      const isValidation = err instanceof RpcValidationError;
      if (!isValidation) {
        this.logger.error("handler", `Handler error for ${request.method}`, err);
      }
      const code = isValidation ? JSON_RPC_INVALID_PARAMS : JSON_RPC_INTERNAL_ERROR;
      const message = isValidation ? (err as RpcValidationError).message : "Internal server error";
      const errResp = createJsonRpcError(request.id, code, message);
      this.safeSend(ws, JSON.stringify(errResp));
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
    this.logger.info("auth", `Client ${client.id} authenticated from ${anonymizeIp(client.ip)}`);
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
    // Finding #13: Log specific reason server-side, send generic message to client
    this.logger.warn("auth-failure", `Auth failed for client ${client.id}: ${reason}`, {
      ip: anonymizeIp(client.ip),
    });
    const genericMessage = "Authentication failed";
    if (jsonRpcId) {
      const errResp = createJsonRpcError(jsonRpcId, -32000, genericMessage);
      ws.send(JSON.stringify(errResp));
    }
    ws.close(4001, genericMessage);
    this.eventBus.publish(
      "gateway:client_connected",
      { clientId: client.id, authenticated: false },
      { source: "gateway" },
    );
  }

  private handleClose(ws: ServerWS, code: number, reason: string): void {
    const clientId = ws.data.clientId;
    this.clients.delete(clientId);
    this.statusSubscribers.delete(clientId);
    this.logger.info("close", `Client ${clientId} disconnected`, {
      code,
      reason: reason || "none",
    });
    this.eventBus.publish("gateway:client_disconnected", { clientId, code, reason }, { source: "gateway" });
  }

  /** Send data over a WebSocket, catching errors to prevent unhandled throws. */
  private safeSend(ws: ServerWS, data: string): void {
    try {
      ws.send(data);
    } catch (err) {
      this.logger.warn("send", `Failed to send response to client ${ws.data.clientId}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
