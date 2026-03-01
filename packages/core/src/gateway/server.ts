/**
 * WebSocket Gateway Server using Bun's native WebSocket support.
 *
 * Desktop/iOS clients connect here to communicate with the Eidolon core
 * via JSON-RPC 2.0 over WebSocket.
 *
 * Authentication is required on the first message (ClientAuth) unless
 * the config sets auth.type to "none".
 */

import { randomUUID } from "node:crypto";
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
  readonly ws: ServerWS;
  authenticated: boolean;
}

interface WSData {
  clientId: string;
}

// ---------------------------------------------------------------------------
// GatewayServer
// ---------------------------------------------------------------------------

export class GatewayServer {
  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;

  private readonly clients: Map<string, ClientState> = new Map();
  private readonly handlers: Map<GatewayMethod, MethodHandler> = new Map();
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(deps: { config: GatewayConfig; logger: Logger; eventBus: EventBus }) {
    this.config = deps.config;
    this.logger = deps.logger.child("gateway");
    this.eventBus = deps.eventBus;
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

    this.server = Bun.serve<WSData>({
      port,
      hostname: host,

      fetch(req, server) {
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          const clientId = randomUUID();
          const upgraded = server.upgrade(req, { data: { clientId } });
          if (!upgraded) {
            return new Response("WebSocket upgrade failed", { status: 400 });
          }
          return undefined;
        }
        return new Response("Not found", { status: 404 });
      },

      websocket: {
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

    this.logger.info("start", `Gateway server listening on ${host}:${port}`);
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
    const clientId = ws.data.clientId;
    const requiresAuth = this.config.auth.type !== "none";

    const state: ClientState = {
      id: clientId,
      ws,
      authenticated: !requiresAuth,
    };
    this.clients.set(clientId, state);

    if (!requiresAuth) {
      this.logger.info("open", `Client ${clientId} connected (auth: none)`);
      this.eventBus.publish("gateway:client_connected", { clientId, authenticated: true }, { source: "gateway" });
    } else {
      this.logger.info("open", `Client ${clientId} connected, awaiting auth`);
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
      ws.close(4001, "Invalid auth payload");
      this.eventBus.publish(
        "gateway:client_connected",
        { clientId: client.id, authenticated: false },
        { source: "gateway" },
      );
      return;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      ws.close(4001, "Invalid auth payload");
      this.eventBus.publish(
        "gateway:client_connected",
        { clientId: client.id, authenticated: false },
        { source: "gateway" },
      );
      return;
    }

    const auth = parsed as Record<string, unknown>;

    if (auth.type !== "token" || typeof auth.token !== "string") {
      ws.close(4001, "Invalid auth: expected { type: 'token', token: string }");
      this.eventBus.publish(
        "gateway:client_connected",
        { clientId: client.id, authenticated: false },
        { source: "gateway" },
      );
      return;
    }

    // Resolve configured token (could be a SecretRef string or plain string)
    const configToken = this.config.auth.token;
    if (typeof configToken !== "string" || auth.token !== configToken) {
      ws.close(4001, "Authentication failed");
      this.eventBus.publish(
        "gateway:client_connected",
        { clientId: client.id, authenticated: false },
        { source: "gateway" },
      );
      return;
    }

    // Auth succeeded
    client.authenticated = true;
    this.logger.info("auth", `Client ${client.id} authenticated`);
    this.eventBus.publish(
      "gateway:client_connected",
      { clientId: client.id, authenticated: true },
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
