/**
 * WebSocket Gateway Server using Bun's native WebSocket support.
 *
 * Desktop/iOS clients connect here to communicate with the Eidolon core
 * via JSON-RPC 2.0 over WebSocket.
 *
 * Responsibilities split across sub-modules to stay under 300 lines:
 *   - client-manager.ts      Client connection lifecycle, auth, messaging
 *   - webhook-routing.ts     WhatsApp and generic webhook HTTP handlers
 *   - server-helpers.ts      Constants, types, utility functions
 *   - builtin-handlers.ts    Built-in RPC handler registration
 */

import { randomUUID } from "node:crypto";
import type { BrainConfig, GatewayConfig, GatewayMethod, GatewayPushEvent, GatewayPushType } from "@eidolon/protocol";
import type { CalendarManager } from "../calendar/index.ts";
import type { WhatsAppChannel } from "../channels/whatsapp/channel.ts";
import type { ModelRouter } from "../llm/router.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import { formatPrometheus, type MetricsRegistry, PROMETHEUS_CONTENT_TYPE } from "../metrics/prometheus.ts";
import type { RateLimitTracker } from "../metrics/rate-limits.ts";
import type { ITracer } from "../telemetry/tracer.ts";
import { NoopTracer } from "../telemetry/tracer.ts";
import { registerBuiltinHandlers } from "./builtin-handlers.ts";
import { ClientManager } from "./client-manager.ts";
import { handleOpenAIRequest, type OpenAICompatDeps } from "./openai-compat.ts";
import { AuthRateLimiter } from "./rate-limiter.ts";
import {
  anonymizeIp,
  type MethodHandler,
  normalizeIp,
  normalizeOrigin,
  SECURITY_HEADERS,
  secureResponse,
  WS_IDLE_TIMEOUT_SECONDS,
  type WSData,
} from "./server-helpers.ts";
import { handleWebhookRoute, handleWhatsAppWebhook, type WhatsAppWebhookState } from "./webhook-routing.ts";

export type { MethodHandler } from "./server-helpers.ts";
// Re-export for backward compatibility
export { anonymizeIp, constantTimeCompare, normalizeIp, normalizeOrigin } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// GatewayServer
// ---------------------------------------------------------------------------

export class GatewayServer {
  private readonly config: GatewayConfig;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly metricsRegistry: MetricsRegistry | undefined;
  private readonly modelRouter: ModelRouter | undefined;
  private readonly brainConfig: BrainConfig | undefined;

  private readonly handlers: Map<GatewayMethod, MethodHandler> = new Map();
  private readonly clientManager: ClientManager;
  private readonly rateLimiter: AuthRateLimiter;
  private readonly whatsAppState: WhatsAppWebhookState = {
    channel: undefined,
    verifyToken: undefined,
    appSecret: undefined,
  };
  private startTime = 0;
  private server: ReturnType<typeof Bun.serve> | undefined;

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
    this.modelRouter = deps.modelRouter;
    this.brainConfig = deps.brainConfig;
    this.rateLimiter = new AuthRateLimiter(deps.config.rateLimiting, this.logger);

    const tracer = deps.tracer ?? new NoopTracer();

    this.clientManager = new ClientManager(
      this.logger,
      this.eventBus,
      this.rateLimiter,
      tracer,
      this.handlers,
      () => this.config.auth,
    );

    registerBuiltinHandlers({
      logger: this.logger,
      eventBus: this.eventBus,
      rateLimitTracker: deps.rateLimitTracker,
      calendarManager: deps.calendarManager,
      registerHandler: (method, handler) => this.registerHandler(method, handler),
      getClient: (id) => this.clientManager.getClient(id),
      getClients: () => this.clientManager.allClients(),
      getClientCount: () => this.clientManager.size,
      isSubscribed: (id) => this.clientManager.isSubscribed(id),
      addSubscriber: (id) => this.clientManager.addSubscriber(id),
      pushToSubscribers: (type, data) => this.clientManager.pushToSubscribers(type, data),
      sendToClient: (id, data) => this.clientManager.sendToClient(id, data),
      isRunning: () => this.server !== undefined,
      getStartTime: () => this.startTime,
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

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
      this.config.tls.enabled && tlsCert && tlsKey ? { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) } : undefined;

    try {
      this.server = Bun.serve<WSData>({
        port,
        hostname: host,
        ...(tlsConfig ? { tls: tlsConfig } : {}),

        async fetch(req, server) {
          return self.handleFetch(req, server);
        },

        websocket: {
          maxPayloadLength: self.config.maxMessageBytes,
          idleTimeout: WS_IDLE_TIMEOUT_SECONDS,
          open(ws) {
            self.clientManager.handleOpen(ws);
          },
          message(ws, message) {
            self.clientManager.handleMessage(ws, message).catch((err: unknown) => {
              self.logger.error("message", "Unhandled error in message handler", err, {
                clientId: ws.data.clientId,
              });
            });
          },
          close(ws, code, reason) {
            self.clientManager.handleClose(ws, code, reason);
          },
        },
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("EADDRINUSE")) {
        const msg = `Port ${port} is already in use. Another Eidolon instance may be running.`;
        this.logger.error("start", msg);
        throw new Error(msg, { cause: err });
      }
      throw err;
    }

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

  async stop(): Promise<void> {
    if (!this.server) return;

    this.clientManager.dispose();
    this.server.stop(true);
    this.server = undefined;
    this.rateLimiter.dispose();
    this.logger.info("stop", "Gateway server stopped");
  }

  // -------------------------------------------------------------------------
  // HTTP fetch handler
  // -------------------------------------------------------------------------

  private async handleFetch(
    req: Request,
    server: {
      requestIP(req: Request): { address: string } | null;
      upgrade(req: Request, options: { data: WSData }): boolean;
    },
  ): Promise<Response | undefined> {
    const url = new URL(req.url);
    const isTls = this.config.tls.enabled;

    if (url.pathname === "/health" && req.method === "GET") {
      return this.handleHealthRequest(isTls);
    }

    if (url.pathname === "/metrics" && req.method === "GET") {
      return this.handleMetricsRequest(isTls);
    }

    if (url.pathname === "/webhooks/whatsapp" && (req.method === "GET" || req.method === "POST")) {
      return handleWhatsAppWebhook(req, this.whatsAppState, this.logger, isTls);
    }

    if (url.pathname.startsWith("/webhooks/") && req.method === "POST") {
      const endpointId = url.pathname.slice("/webhooks/".length);
      return handleWebhookRoute(req, endpointId, this.config, this.logger, this.eventBus, isTls);
    }

    if (url.pathname.startsWith("/v1/")) {
      const openAIDeps: OpenAICompatDeps = {
        logger: this.logger,
        brainConfig: this.brainConfig,
        router: this.modelRouter,
        authToken: typeof this.config.auth.token === "string" ? this.config.auth.token : undefined,
      };
      const openAIResp = await handleOpenAIRequest(req, openAIDeps);
      if (openAIResp) return openAIResp;
    }

    if (url.pathname !== "/ws") return secureResponse("Not found", 404, isTls);

    return this.handleWsUpgrade(req, server, isTls);
  }

  private handleHealthRequest(isTls: boolean): Response {
    const uptimeMs = this.startTime > 0 ? Date.now() - this.startTime : 0;
    const body = JSON.stringify({
      status: "healthy",
      uptime: uptimeMs,
      connectedClients: this.clientManager.size,
      timestamp: Date.now(),
    });
    const headers: Record<string, string> = { ...SECURITY_HEADERS, "Content-Type": "application/json" };
    if (isTls) headers["Strict-Transport-Security"] = "max-age=31536000";
    return new Response(body, { status: 200, headers });
  }

  private handleMetricsRequest(isTls: boolean): Response {
    if (!this.metricsRegistry) return secureResponse("Metrics not configured", 404, isTls);
    const body = formatPrometheus(this.metricsRegistry);
    const headers: Record<string, string> = { ...SECURITY_HEADERS, "Content-Type": PROMETHEUS_CONTENT_TYPE };
    if (isTls) headers["Strict-Transport-Security"] = "max-age=31536000";
    return new Response(body, { status: 200, headers });
  }

  private handleWsUpgrade(
    req: Request,
    server: {
      requestIP(req: Request): { address: string } | null;
      upgrade(req: Request, options: { data: WSData }): boolean;
    },
    isTls: boolean,
  ): Response | undefined {
    const ip = normalizeIp(server.requestIP(req)?.address ?? "unknown");
    const anonIp = anonymizeIp(ip);

    if (this.rateLimiter.isBlocked(ip)) {
      this.logger.warn("fetch", `Rate-limited IP ${anonIp} attempted connection`);
      return secureResponse("Too Many Requests", 429, isTls);
    }

    if (this.clientManager.size >= this.config.maxClients) {
      this.logger.warn("fetch", `Connection limit reached (${this.config.maxClients}), rejecting ${anonIp}`);
      return secureResponse("Service Unavailable", 503, isTls);
    }

    if (this.config.allowedOrigins.length > 0) {
      const origin = normalizeOrigin(req.headers.get("Origin") ?? "");
      const allowed = this.config.allowedOrigins.some((o) => normalizeOrigin(o) === origin);
      if (!allowed) {
        this.logger.warn("fetch", `Rejected origin "${origin}" from ${anonIp}`);
        return secureResponse("Forbidden", 403, isTls);
      }
    }

    const clientId = randomUUID();
    const upgraded = server.upgrade(req, { data: { clientId, ip } });
    if (!upgraded) return secureResponse("WebSocket upgrade failed", 400);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // WhatsApp webhook setup
  // -------------------------------------------------------------------------

  setWhatsAppChannel(channel: WhatsAppChannel, verifyToken: string, appSecret: string): void {
    this.whatsAppState.channel = channel;
    this.whatsAppState.verifyToken = verifyToken;
    this.whatsAppState.appSecret = appSecret;
    this.logger.info("whatsapp-webhook", "WhatsApp webhook handler registered");
  }

  // -------------------------------------------------------------------------
  // Handler registration & public messaging API
  // -------------------------------------------------------------------------

  registerHandler(method: GatewayMethod, handler: MethodHandler): void {
    this.handlers.set(method, handler);
    this.logger.debug("register", `Registered handler for ${method}`);
  }

  broadcast(event: GatewayPushEvent): void {
    this.clientManager.broadcastToAll(JSON.stringify(event));
  }

  broadcastStatus(status: Record<string, unknown>): void {
    this.clientManager.broadcastStatus(status);
  }

  pushToSubscribers(type: GatewayPushType, data: Record<string, unknown>): void {
    this.clientManager.pushToSubscribers(type, data);
  }

  sendTo(clientId: string, event: GatewayPushEvent): void {
    this.clientManager.sendTo(clientId, JSON.stringify(event));
  }

  // -------------------------------------------------------------------------
  // Getters
  // -------------------------------------------------------------------------

  get connectedClients(): number {
    return this.clientManager.size;
  }

  get isRunning(): boolean {
    return this.server !== undefined;
  }
}
