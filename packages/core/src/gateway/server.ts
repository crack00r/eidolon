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

import { randomUUID } from "node:crypto";
import type { BrainConfig, GatewayConfig, GatewayMethod, GatewayPushEvent, GatewayPushType } from "@eidolon/protocol";
import type { CalendarManager } from "../calendar/index.ts";
import type { WhatsAppChannel } from "../channels/whatsapp/channel.ts";
import {
  handleVerificationChallenge,
  parseWebhookPayload,
  verifyWebhookSignature,
} from "../channels/whatsapp/webhook.ts";
import type { ModelRouter } from "../llm/router.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import { formatPrometheus, type MetricsRegistry, PROMETHEUS_CONTENT_TYPE } from "../metrics/prometheus.ts";
import type { RateLimitTracker } from "../metrics/rate-limits.ts";
import type { ITracer } from "../telemetry/tracer.ts";
import { NoopTracer } from "../telemetry/tracer.ts";
import { registerBuiltinHandlers } from "./builtin-handlers.ts";
import { handleOpenAIRequest, type OpenAICompatDeps } from "./openai-compat.ts";
import {
  createJsonRpcError,
  createJsonRpcResponse,
  createPushEvent,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_METHOD_NOT_FOUND,
  parseJsonRpcRequest,
} from "./protocol.ts";
import { AuthRateLimiter } from "./rate-limiter.ts";
import { RpcValidationError } from "./rpc-schemas.ts";
import {
  anonymizeIp,
  AUTH_TIMEOUT_MS,
  type ClientState,
  constantTimeCompare,
  type MethodHandler,
  normalizeIp,
  normalizeOrigin,
  secureResponse,
  SECURITY_HEADERS,
  type ServerWS,
  WS_IDLE_TIMEOUT_SECONDS,
  type WSData,
} from "./server-helpers.ts";
import { extractWebhookResult, handleWebhookRequest, type WebhookDeps } from "./webhook.ts";

// Re-export for backward compatibility
export { anonymizeIp, constantTimeCompare, normalizeIp, normalizeOrigin } from "./server-helpers.ts";
export type { MethodHandler } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// GatewayServer
// ---------------------------------------------------------------------------

export class GatewayServer {
  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly rateLimiter: AuthRateLimiter;
  private readonly metricsRegistry: MetricsRegistry | undefined;
  private readonly tracer: ITracer;
  private readonly modelRouter: ModelRouter | undefined;
  private readonly brainConfig: BrainConfig | undefined;

  private readonly clients: Map<string, ClientState> = new Map();
  private readonly handlers: Map<GatewayMethod, MethodHandler> = new Map();
  private readonly statusSubscribers: Set<string> = new Set();
  /** ERR-001: Track auth timeout timers per client for proper cleanup. */
  private readonly authTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private broadcastFailureCount = 0;
  private startTime = 0;
  private server: ReturnType<typeof Bun.serve> | undefined;

  /** WhatsApp channel reference for webhook routing. Set via setWhatsAppChannel(). */
  private whatsAppChannel: WhatsAppChannel | undefined;
  private whatsAppVerifyToken: string | undefined;
  private whatsAppAppSecret: string | undefined;

  constructor(deps: {
    config: GatewayConfig;
    logger: Logger;
    eventBus: EventBus;
    metricsRegistry?: MetricsRegistry;
    rateLimitTracker?: RateLimitTracker;
    calendarManager?: CalendarManager;
    tracer?: ITracer;
    modelRouter?: ModelRouter;
    brainConfig?: BrainConfig;
  }) {
    this.config = deps.config;
    this.logger = deps.logger.child("gateway");
    this.eventBus = deps.eventBus;
    this.metricsRegistry = deps.metricsRegistry;
    this.tracer = deps.tracer ?? new NoopTracer();
    this.modelRouter = deps.modelRouter;
    this.brainConfig = deps.brainConfig;
    this.rateLimiter = new AuthRateLimiter(deps.config.rateLimiting, this.logger);

    registerBuiltinHandlers({
      logger: this.logger,
      eventBus: this.eventBus,
      rateLimitTracker: deps.rateLimitTracker,
      calendarManager: deps.calendarManager,
      registerHandler: (method, handler) => this.registerHandler(method, handler),
      getClient: (id) => this.clients.get(id),
      getClients: () => this.clients.values(),
      getClientCount: () => this.clients.size,
      isSubscribed: (id) => this.statusSubscribers.has(id),
      addSubscriber: (id) => this.statusSubscribers.add(id),
      pushToSubscribers: (type, data) => this.pushToSubscribers(type, data),
      sendToClient: (id, data) => {
        const client = this.clients.get(id);
        if (!client || !client.authenticated) return false;
        try {
          client.ws.send(data);
          return true;
        } catch {
          return false;
        }
      },
      isRunning: () => this.server !== undefined,
      getStartTime: () => this.startTime,
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
        ? { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) }
        : undefined;

    this.server = Bun.serve<WSData>({
      port,
      hostname: host,
      ...(tlsConfig ? { tls: tlsConfig } : {}),

      async fetch(req, server) {
        const url = new URL(req.url);
        const isTls = self.config.tls.enabled;

        // GET /health
        if (url.pathname === "/health" && req.method === "GET") {
          const uptimeMs = self.startTime > 0 ? Date.now() - self.startTime : 0;
          const body = JSON.stringify({
            status: "healthy",
            uptime: uptimeMs,
            connectedClients: self.clients.size,
            timestamp: Date.now(),
          });
          const headers: Record<string, string> = { ...SECURITY_HEADERS, "Content-Type": "application/json" };
          if (isTls) headers["Strict-Transport-Security"] = "max-age=31536000";
          return new Response(body, { status: 200, headers });
        }

        // GET /metrics
        if (url.pathname === "/metrics" && req.method === "GET") {
          if (!self.metricsRegistry) return secureResponse("Metrics not configured", 404, isTls);
          const body = formatPrometheus(self.metricsRegistry);
          const headers: Record<string, string> = { ...SECURITY_HEADERS, "Content-Type": PROMETHEUS_CONTENT_TYPE };
          if (isTls) headers["Strict-Transport-Security"] = "max-age=31536000";
          return new Response(body, { status: 200, headers });
        }

        // WhatsApp webhook
        if (url.pathname === "/webhooks/whatsapp" && (req.method === "GET" || req.method === "POST")) {
          return self.handleWhatsAppWebhook(req, isTls);
        }

        // Generic webhook
        if (url.pathname.startsWith("/webhooks/") && req.method === "POST") {
          const endpointId = url.pathname.slice("/webhooks/".length);
          return self.handleWebhookRoute(req, endpointId, isTls);
        }

        // OpenAI-compatible REST API
        if (url.pathname.startsWith("/v1/")) {
          const openAIDeps: OpenAICompatDeps = {
            logger: self.logger,
            brainConfig: self.brainConfig,
            router: self.modelRouter,
            authToken: typeof self.config.auth.token === "string" ? self.config.auth.token : undefined,
          };
          const openAIResp = await handleOpenAIRequest(req, openAIDeps);
          if (openAIResp) return openAIResp;
        }

        if (url.pathname !== "/ws") return secureResponse("Not found", 404, isTls);

        // WebSocket upgrade
        const ip = normalizeIp(server.requestIP(req)?.address ?? "unknown");
        const anonIp = anonymizeIp(ip);

        if (self.rateLimiter.isBlocked(ip)) {
          self.logger.warn("fetch", `Rate-limited IP ${anonIp} attempted connection`);
          return secureResponse("Too Many Requests", 429, isTls);
        }

        if (self.clients.size >= self.config.maxClients) {
          self.logger.warn("fetch", `Connection limit reached (${self.config.maxClients}), rejecting ${anonIp}`);
          return secureResponse("Service Unavailable", 503, isTls);
        }

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
        if (!upgraded) return secureResponse("WebSocket upgrade failed", 400);
        return undefined;
      },

      websocket: {
        maxPayloadLength: self.config.maxMessageBytes,
        idleTimeout: WS_IDLE_TIMEOUT_SECONDS,
        open(ws) {
          self.handleOpen(ws);
        },
        message(ws, message) {
          self.handleMessage(ws, message).catch((err: unknown) => {
            self.logger.error("message", "Unhandled error in message handler", err, {
              clientId: ws.data.clientId,
            });
          });
        },
        close(ws, code, reason) {
          self.handleClose(ws, code, reason);
        },
      },
    });

    this.startTime = Date.now();
    const scheme = this.config.tls.enabled ? "wss" : "ws";
    this.logger.info("start", `Gateway server listening on ${scheme}://${host}:${port}`);

    if (this.config.allowedOrigins.length === 0) {
      this.logger.warn(
        "security",
        "Gateway has no allowedOrigins configured. All origins will be accepted. Set allowedOrigins in production.",
      );
    }

    if (!this.config.tls.enabled && this.config.auth.type === "token" && typeof this.config.auth.token === "string") {
      this.logger.warn(
        "security",
        "Gateway running without TLS. Auth tokens transmitted in plaintext. Enable TLS in production.",
      );
    }
  }

  /** Graceful shutdown: close all connections and stop the server. */
  async stop(): Promise<void> {
    if (!this.server) return;

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

    this.server.stop(true);
    this.server = undefined;
    this.rateLimiter.dispose();
    this.logger.info("stop", "Gateway server stopped");
  }

  // -------------------------------------------------------------------------
  // Webhook routing
  // -------------------------------------------------------------------------

  private async handleWebhookRoute(req: Request, endpointId: string, isTls: boolean): Promise<Response> {
    const endpoints = this.config.webhooks?.endpoints ?? [];
    const endpointConfig = endpoints.find((ep) => ep.id === endpointId);

    if (endpointConfig && !endpointConfig.enabled) return secureResponse("Not found", 404, isTls);

    let resolvedToken: string | undefined;
    if (endpointConfig) {
      resolvedToken = typeof endpointConfig.token === "string" ? endpointConfig.token : undefined;
    } else {
      resolvedToken = typeof this.config.auth.token === "string" ? this.config.auth.token : undefined;
    }

    const deps: WebhookDeps = { logger: this.logger, gatewayToken: resolvedToken };
    const response = await handleWebhookRequest(req, deps);

    const result = extractWebhookResult(response);
    if (result) {
      const priority = endpointConfig?.priority ?? "normal";
      const eventType = (endpointConfig?.eventType ?? "webhook:received") as "webhook:received";

      this.eventBus.publish(
        eventType,
        {
          webhookId: result.id,
          endpointId,
          source: result.payload.source,
          event: result.payload.event,
          data: result.payload.data,
        },
        { priority, source: `webhook:${endpointId}` },
      );

      this.logger.info("webhook", `Published ${eventType} from endpoint "${endpointId}"`, {
        webhookId: result.id,
        source: result.payload.source,
        event: result.payload.event,
        priority,
      });
    }

    return response;
  }

  // -------------------------------------------------------------------------
  // WhatsApp webhook integration
  // -------------------------------------------------------------------------

  setWhatsAppChannel(channel: WhatsAppChannel, verifyToken: string, appSecret: string): void {
    this.whatsAppChannel = channel;
    this.whatsAppVerifyToken = verifyToken;
    this.whatsAppAppSecret = appSecret;
    this.logger.info("whatsapp-webhook", "WhatsApp webhook handler registered");
  }

  private async handleWhatsAppWebhook(req: Request, isTls: boolean): Promise<Response> {
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (!this.whatsAppVerifyToken) return secureResponse("WhatsApp webhook not configured", 503, isTls);
      const result = handleVerificationChallenge(url.searchParams, this.whatsAppVerifyToken);
      if (result.ok) {
        this.logger.info("whatsapp-webhook", "Verification challenge accepted");
        return new Response(result.value, { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      this.logger.warn("whatsapp-webhook", `Verification failed: ${result.error.message}`);
      return secureResponse("Verification failed", 403, isTls);
    }

    if (req.method === "POST") {
      if (!this.whatsAppChannel || !this.whatsAppAppSecret) {
        return secureResponse("WhatsApp webhook not configured", 503, isTls);
      }

      let bodyText: string;
      try {
        bodyText = await req.text();
      } catch {
        return secureResponse("Failed to read body", 400, isTls);
      }

      const signature = req.headers.get("X-Hub-Signature-256") ?? "";
      const signatureValid = await verifyWebhookSignature(bodyText, signature, this.whatsAppAppSecret);
      if (!signatureValid) {
        this.logger.warn("whatsapp-webhook", "Invalid webhook signature");
        return secureResponse("Invalid signature", 401, isTls);
      }

      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        return secureResponse("Invalid JSON", 400, isTls);
      }

      const parseResult = parseWebhookPayload(body);
      if (!parseResult.ok) {
        this.logger.warn("whatsapp-webhook", `Payload parse error: ${parseResult.error.message}`);
        return new Response("OK", { status: 200 });
      }

      if (parseResult.value.length > 0) {
        this.whatsAppChannel.handleWebhookEvents(parseResult.value).catch((err: unknown) => {
          this.logger.error("whatsapp-webhook", "Error handling webhook events", err);
        });
      }

      return new Response("OK", { status: 200 });
    }

    return secureResponse("Method not allowed", 405, isTls);
  }

  // -------------------------------------------------------------------------
  // Handler registration & push events
  // -------------------------------------------------------------------------

  registerHandler(method: GatewayMethod, handler: MethodHandler): void {
    this.handlers.set(method, handler);
    this.logger.debug("register", `Registered handler for ${method}`);
  }

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

  sendTo(clientId: string, event: GatewayPushEvent): void {
    const client = this.clients.get(clientId);
    if (!client) {
      this.logger.warn("sendTo", `Client ${clientId} not found`);
      return;
    }
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

  private async handleMessage(ws: ServerWS, message: string | Buffer): Promise<void> {
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

    const result = parseJsonRpcRequest(text);
    if (!result.ok) {
      this.safeSend(ws, JSON.stringify(result.error));
      return;
    }

    const request = result.value;
    const handler = this.handlers.get(request.method);
    if (!handler) {
      const errResp = createJsonRpcError(request.id, JSON_RPC_METHOD_NOT_FOUND, `No handler registered for ${request.method}`);
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
    const isJsonRpc = obj.jsonrpc === "2.0" && typeof obj.method === "string";
    let token: string | undefined;
    let jsonRpcId: string | undefined;

    if (isJsonRpc) {
      if (obj.method !== "auth.authenticate") {
        this.emitAuthFailure(ws, client, "Expected auth.authenticate method", obj.id as string);
        return;
      }
      jsonRpcId = typeof obj.id === "string" ? obj.id : undefined;
      const params = obj.params as Record<string, unknown> | undefined;
      if (params && typeof params.token === "string") token = params.token;
    } else {
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

    const configToken = this.config.auth.token;
    if (typeof configToken !== "string" || !constantTimeCompare(token, configToken)) {
      this.rateLimiter.recordFailure(client.ip);
      this.emitAuthFailure(ws, client, "Authentication failed", jsonRpcId);
      return;
    }

    this.rateLimiter.recordSuccess(client.ip);
    client.authenticated = true;

    const authTimer = this.authTimers.get(client.id);
    if (authTimer) {
      clearTimeout(authTimer);
      this.authTimers.delete(client.id);
    }

    if (isJsonRpc) {
      const params = obj.params as Record<string, unknown> | undefined;
      if (params) {
        if (typeof params.platform === "string") client.platform = params.platform;
        if (typeof params.version === "string") client.version = params.version;
      }
    }

    this.logger.info("auth", `Client ${client.id} authenticated from ${anonymizeIp(client.ip)}`);
    this.eventBus.publish("gateway:client_connected", { clientId: client.id, authenticated: true }, { source: "gateway" });
    this.pushToSubscribers("push.clientConnected", {
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

  private emitAuthFailure(ws: ServerWS, client: ClientState, reason: string, jsonRpcId?: string): void {
    this.logger.warn("auth-failure", `Auth failed for client ${client.id}: ${reason}`, { ip: anonymizeIp(client.ip) });
    const genericMessage = "Authentication failed";
    if (jsonRpcId) {
      const errResp = createJsonRpcError(jsonRpcId, -32000, genericMessage);
      ws.send(JSON.stringify(errResp));
    }
    ws.close(4001, genericMessage);
    this.eventBus.publish("gateway:client_connected", { clientId: client.id, authenticated: false }, { source: "gateway" });
  }

  private handleClose(ws: ServerWS, code: number, reason: string): void {
    const clientId = ws.data.clientId;
    const client = this.clients.get(clientId);

    const authTimer = this.authTimers.get(clientId);
    if (authTimer) {
      clearTimeout(authTimer);
      this.authTimers.delete(clientId);
    }

    this.clients.delete(clientId);
    this.statusSubscribers.delete(clientId);
    this.logger.info("close", `Client ${clientId} disconnected`, { code, reason: reason || "none" });
    this.eventBus.publish("gateway:client_disconnected", { clientId, code, reason }, { source: "gateway" });
    this.pushToSubscribers("push.clientDisconnected", {
      clientId,
      platform: client?.platform ?? "unknown",
      version: client?.version ?? "unknown",
      timestamp: Date.now(),
    });
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
