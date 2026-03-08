/**
 * WebSocket client connection management: open, message, auth, close handlers.
 * Extracted from server.ts to keep files under 300 lines.
 */

import type { GatewayMethod, GatewayPushType } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { ITracer } from "../telemetry/tracer.ts";
import { handleClientAuth } from "./client-manager-auth.ts";
import {
  createJsonRpcError,
  createJsonRpcResponse,
  createPushEvent,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  parseJsonRpcRequest,
} from "./protocol.ts";
import type { AuthRateLimiter } from "./rate-limiter.ts";
import { cleanupVoiceSessionForClient } from "./rpc-handlers-voice.ts";
import { RpcValidationError } from "./rpc-schemas.ts";
import {
  AUTH_TIMEOUT_MS,
  anonymizeIp,
  type ClientState,
  MAX_MESSAGES_PER_SECOND,
  MESSAGE_RATE_WINDOW_MS,
  type MethodHandler,
  type ServerWS,
} from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// ClientManager -- manages connected WebSocket clients
// ---------------------------------------------------------------------------

export class ClientManager {
  private readonly clients: Map<string, ClientState> = new Map();
  private readonly statusSubscribers: Set<string> = new Set();
  /** ERR-001: Track auth timeout timers per client for proper cleanup. */
  private readonly authTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private broadcastFailureCount = 0;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly eventBus: EventBus,
    private readonly rateLimiter: AuthRateLimiter,
    private readonly tracer: ITracer,
    private readonly handlers: Map<GatewayMethod, MethodHandler>,
    private readonly getAuthConfig: () => { type: string; token?: string | Record<string, unknown> },
  ) {}

  startCleanup(): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.sweepStaleClients();
    }, 300_000);
    this.cleanupTimer.unref();
  }

  private sweepStaleClients(): void {
    const now = Date.now();
    const staleThresholdMs = 300_000;
    for (const [id, client] of this.clients) {
      if (!client.authenticated && now - client.connectedAt > staleThresholdMs) {
        this.logger.info("sweep", `Removing stale unauthenticated client ${id}`);
        try {
          client.ws.close(4003, "Stale connection");
        } catch {
          // Already disconnected
        }
        this.clients.delete(id);
        this.statusSubscribers.delete(id);
        const authTimer = this.authTimers.get(id);
        if (authTimer) {
          clearTimeout(authTimer);
          this.authTimers.delete(id);
        }
      }
    }
  }

  get size(): number {
    return this.clients.size;
  }

  getClient(id: string): ClientState | undefined {
    return this.clients.get(id);
  }

  allClients(): IterableIterator<ClientState> {
    return this.clients.values();
  }

  isSubscribed(id: string): boolean {
    return this.statusSubscribers.has(id);
  }

  addSubscriber(id: string): void {
    this.statusSubscribers.add(id);
  }

  sendToClient(id: string, data: string): boolean {
    const client = this.clients.get(id);
    if (!client || !client.authenticated) return false;
    try {
      client.ws.send(data);
      return true;
    } catch {
      // Intentional: WebSocket send may fail if client disconnected
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Push & broadcast
  // -------------------------------------------------------------------------

  pushToSubscribers(type: GatewayPushType, data: Record<string, unknown>): void {
    if (this.statusSubscribers.size === 0) return;
    const event = createPushEvent(type, data);
    const payload = JSON.stringify(event);
    for (const clientId of this.statusSubscribers) {
      const client = this.clients.get(clientId);
      if (!client || !client.authenticated) {
        this.statusSubscribers.delete(clientId);
        continue;
      }
      try {
        client.ws.send(payload);
      } catch {
        this.statusSubscribers.delete(clientId);
        this.logger.warn("push", `Removed unreachable subscriber ${clientId}`);
      }
    }
  }

  broadcastToAll(data: string): void {
    let failures = 0;
    for (const client of this.clients.values()) {
      if (client.authenticated) {
        try {
          client.ws.send(data);
        } catch {
          // Intentional: count failed sends rather than aborting broadcast
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

  sendTo(clientId: string, data: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      this.logger.warn("sendTo", `Client ${clientId} not found`);
      return;
    }
    if (!client.authenticated) return;
    try {
      client.ws.send(data);
    } catch {
      this.logger.warn("sendTo", `Failed to send to client ${clientId}`);
    }
  }

  // -------------------------------------------------------------------------
  // WebSocket lifecycle callbacks
  // -------------------------------------------------------------------------

  handleOpen(ws: ServerWS): void {
    const { clientId, ip } = ws.data;
    const anonIp = anonymizeIp(ip);
    const authConfig = this.getAuthConfig();
    const requiresAuth = authConfig.type !== "none";

    const state: ClientState = {
      id: clientId,
      ip,
      ws,
      authenticated: !requiresAuth,
      platform: "unknown",
      version: "unknown",
      connectedAt: Date.now(),
      messageCount: 0,
      messageWindowStart: Date.now(),
    };
    this.clients.set(clientId, state);

    if (!requiresAuth) {
      this.logger.warn("open", `Client ${clientId} connected (auth: none) -- authentication is disabled`);
      this.eventBus.publish("gateway:client_connected", { clientId, authenticated: true }, { source: "gateway" });
      this.pushToSubscribers("push.clientConnected", {
        clientId,
        platform: state.platform,
        version: state.version,
        timestamp: state.connectedAt,
      });
    } else {
      this.logger.info("open", `Client ${clientId} connected from ${anonIp}, awaiting auth`);
      const authTimer = setTimeout(() => {
        this.authTimers.delete(clientId);
        const client = this.clients.get(clientId);
        if (client && !client.authenticated) {
          this.logger.warn("auth-timeout", `Client ${clientId} auth timeout`, { ip: anonymizeIp(ip) });
          ws.close(4002, "Authentication timeout");
          this.clients.delete(clientId);
        }
      }, AUTH_TIMEOUT_MS);
      this.authTimers.set(clientId, authTimer);
    }
  }

  async handleMessage(ws: ServerWS, message: string | Buffer): Promise<void> {
    const clientId = ws.data.clientId;
    const client = this.clients.get(clientId);

    if (!client) {
      this.logger.warn("message", `Message from unknown client ${clientId}`);
      return;
    }

    const text = typeof message === "string" ? message : Buffer.from(message).toString("utf-8");

    if (!client.authenticated) {
      this.handleAuth(ws, client, text);
      return;
    }

    // SEC-M4: Per-message rate limiting
    const now = Date.now();
    if (now - client.messageWindowStart >= MESSAGE_RATE_WINDOW_MS) {
      client.messageCount = 0;
      client.messageWindowStart = now;
    }
    client.messageCount++;
    if (client.messageCount > MAX_MESSAGES_PER_SECOND) {
      this.logger.warn("rate-limit", `Client ${clientId} exceeded message rate limit`);
      const errResp = createJsonRpcError(null, -32000, "Rate limit exceeded: too many messages per second");
      this.safeSend(ws, JSON.stringify(errResp));
      return;
    }

    const result = parseJsonRpcRequest(text);
    if (!result.ok) {
      this.safeSend(ws, JSON.stringify(result.error));
      return;
    }

    const request = result.value;
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

    const span = this.tracer.startSpan("gateway.rpc", {
      "rpc.method": request.method,
      "rpc.id": request.id,
      "client.id": clientId,
    });

    try {
      const handlerResult = await handler(request.params ?? {}, clientId);
      const response = createJsonRpcResponse(request.id, handlerResult);
      this.safeSend(ws, JSON.stringify(response));
      span.setStatus("ok");
    } catch (err) {
      const isValidation = err instanceof RpcValidationError;
      if (!isValidation) this.logger.error("handler", `Handler error for ${request.method}`, err);
      const code = isValidation ? JSON_RPC_INVALID_PARAMS : JSON_RPC_INTERNAL_ERROR;
      const msg = isValidation ? (err as RpcValidationError).message : "Internal server error";
      const errResp = createJsonRpcError(request.id, code, msg);
      this.safeSend(ws, JSON.stringify(errResp));
      span.setStatus("error", msg);
    } finally {
      span.end();
    }
  }

  handleClose(ws: ServerWS, code: number, reason: string): void {
    const clientId = ws.data.clientId;
    const client = this.clients.get(clientId);

    const authTimer = this.authTimers.get(clientId);
    if (authTimer) {
      clearTimeout(authTimer);
      this.authTimers.delete(clientId);
    }

    this.clients.delete(clientId);
    this.statusSubscribers.delete(clientId);
    cleanupVoiceSessionForClient(clientId);
    this.logger.info("close", `Client ${clientId} disconnected`, { code, reason: reason || "none" });
    this.eventBus.publish("gateway:client_disconnected", { clientId, code, reason }, { source: "gateway" });
    this.pushToSubscribers("push.clientDisconnected", {
      clientId,
      platform: client?.platform ?? "unknown",
      version: client?.version ?? "unknown",
      timestamp: Date.now(),
    });
  }

  /** Clean up all timers and connections (called during server stop). */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    for (const timer of this.authTimers.values()) {
      clearTimeout(timer);
    }
    this.authTimers.clear();

    for (const client of this.clients.values()) {
      try {
        client.ws.close(1001, "Server shutting down");
      } catch {
        // Client may already be disconnected
      }
    }
    this.clients.clear();
  }

  // -------------------------------------------------------------------------
  // Private: send helpers
  // -------------------------------------------------------------------------

  private handleAuth(ws: ServerWS, client: ClientState, text: string): void {
    handleClientAuth(
      ws,
      client,
      text,
      {
        logger: this.logger,
        eventBus: this.eventBus,
        rateLimiter: this.rateLimiter,
        getAuthConfig: this.getAuthConfig,
        pushToSubscribers: (type, data) => this.pushToSubscribers(type, data),
      },
      this.authTimers,
    );
  }

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
