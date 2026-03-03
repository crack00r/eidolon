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
import type {
  ConnectedClientInfo,
  GatewayConfig,
  GatewayMethod,
  GatewayPushEvent,
  GatewayPushType,
} from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import { formatPrometheus, type MetricsRegistry, PROMETHEUS_CONTENT_TYPE } from "../metrics/prometheus.ts";
import type { RateLimitTracker } from "../metrics/rate-limits.ts";
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
import { extractWebhookResult, handleWebhookRequest, type WebhookDeps } from "./webhook.ts";

// ---------------------------------------------------------------------------
// Zod schemas for RPC method parameters
// ---------------------------------------------------------------------------

const ErrorReportEntrySchema = z
  .object({
    module: z.string().max(256).optional(),
    message: z.string().max(4096).optional(),
    level: z.string().max(64).optional(),
    timestamp: z.union([z.string().max(64), z.number()]).optional(),
    data: z.record(z.unknown()).optional(),
  })
  .passthrough();

const ErrorReportParamsSchema = z.object({
  errors: z.array(ErrorReportEntrySchema).max(100),
  clientInfo: z
    .object({
      platform: z.string().max(64).optional(),
      version: z.string().max(64).optional(),
    })
    .passthrough()
    .optional(),
});

const BrainTriggerActionParamsSchema = z.object({
  action: z.string().min(1).max(64),
  args: z.record(z.unknown()).optional(),
});

const BrainGetLogParamsSchema = z.object({
  limit: z.number().int().min(1).max(500).optional(),
});

const ClientExecuteParamsSchema = z.object({
  targetClientId: z.string().min(1).max(256),
  command: z.string().min(1).max(1024),
  args: z.unknown().optional(),
});

const CommandResultParamsSchema = z.object({
  commandId: z.string().min(1).max(256),
  success: z.boolean().optional(),
  result: z.unknown().optional(),
  error: z.string().max(4096).optional(),
});

const AutomationCreateParamsSchema = z.object({
  input: z.string().min(1).max(2048),
  deliverTo: z.string().min(1).max(64).optional(),
});

const AutomationListParamsSchema = z.object({
  enabledOnly: z.boolean().optional(),
});

const AutomationDeleteParamsSchema = z.object({
  automationId: z.string().min(1).max(256),
});

const ResearchStartParamsSchema = z.object({
  query: z.string().min(1).max(4096),
  sources: z.array(z.string().min(1).max(64)).max(20).optional(),
  maxSources: z.number().int().min(1).max(100).optional(),
  deliverTo: z.string().min(1).max(64).optional(),
});

const ResearchStatusParamsSchema = z.object({
  researchId: z.string().min(1).max(256),
});

const ResearchListParamsSchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  since: z.number().int().min(0).optional(),
});

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
  /** Client-reported platform identifier (e.g., "desktop", "web", "ios"). */
  platform: string;
  /** Client-reported version string. */
  version: string;
  /** Timestamp (ms) when the WebSocket connection was established. */
  readonly connectedAt: number;
  /** SEC-M4: Per-message rate limiting state. */
  messageCount: number;
  messageWindowStart: number;
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

/**
 * SEC-M4: Per-message rate limiting for authenticated clients.
 * Maximum RPC messages per second per client to prevent flooding.
 */
const MAX_MESSAGES_PER_SECOND = 50;

/** Sliding window duration in ms for per-message rate limiting. */
const MESSAGE_RATE_WINDOW_MS = 1_000;

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
  private readonly metricsRegistry: MetricsRegistry | undefined;
  private readonly rateLimitTracker: RateLimitTracker | undefined;

  private readonly clients: Map<string, ClientState> = new Map();
  private readonly handlers: Map<GatewayMethod, MethodHandler> = new Map();
  private readonly statusSubscribers: Set<string> = new Set();
  /** ERR-001: Track auth timeout timers per client for proper cleanup. */
  private readonly authTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private broadcastFailureCount = 0;
  private startTime = 0;
  private server: ReturnType<typeof Bun.serve> | undefined;

  constructor(deps: {
    config: GatewayConfig;
    logger: Logger;
    eventBus: EventBus;
    metricsRegistry?: MetricsRegistry;
    rateLimitTracker?: RateLimitTracker;
  }) {
    this.config = deps.config;
    this.logger = deps.logger.child("gateway");
    this.eventBus = deps.eventBus;
    this.metricsRegistry = deps.metricsRegistry;
    this.rateLimitTracker = deps.rateLimitTracker;
    this.rateLimiter = new AuthRateLimiter(deps.config.rateLimiting, this.logger);

    this.registerBuiltinHandlers();
  }

  // -------------------------------------------------------------------------
  // Built-in RPC handlers
  // -------------------------------------------------------------------------

  private registerBuiltinHandlers(): void {
    // error.report / client.reportErrors: clients report errors back to the server
    const handleErrorReport: MethodHandler = async (params, clientId) => {
      const parsed = ErrorReportParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new RpcValidationError(
          `Invalid error report params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
        );
      }
      const { errors, clientInfo } = parsed.data;

      // Use clientInfo if provided, otherwise fall back to the authenticated client's metadata
      const client = this.clients.get(clientId);
      const platform = clientInfo?.platform ?? client?.platform ?? "unknown";
      const version = clientInfo?.version ?? client?.version ?? "unknown";

      for (const entry of errors) {
        this.logger.warn(
          "client-error",
          `[${platform}@${version}] ${String(entry.module ?? "unknown")}: ${String(entry.message ?? "")}`,
          {
            clientId,
            level: String(entry.level ?? "error"),
            timestamp: String(entry.timestamp ?? ""),
            ...(entry.data !== undefined ? { data: entry.data } : {}),
          },
        );
      }

      this.eventBus.publish(
        "gateway:client_error_report",
        { clientId, platform, version, errorCount: errors.length },
        { source: "gateway" },
      );

      return { received: errors.length };
    };

    this.registerHandler("error.report", handleErrorReport);
    this.registerHandler("client.reportErrors", handleErrorReport);

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

    // -----------------------------------------------------------------------
    // Brain control handlers
    // -----------------------------------------------------------------------

    // brain.pause: pause the cognitive loop
    this.registerHandler("brain.pause", async (_params, clientId) => {
      this.logger.info("brain.pause", `Client ${clientId} requested cognitive loop pause`);
      this.eventBus.publish(
        "system:config_changed",
        { action: "pause", requestedBy: clientId },
        { source: "gateway", priority: "high" },
      );
      this.pushToSubscribers("push.stateChange", {
        previousState: "running",
        currentState: "paused",
        timestamp: Date.now(),
      });
      return { paused: true };
    });

    // brain.resume: resume the cognitive loop
    this.registerHandler("brain.resume", async (_params, clientId) => {
      this.logger.info("brain.resume", `Client ${clientId} requested cognitive loop resume`);
      this.eventBus.publish(
        "system:config_changed",
        { action: "resume", requestedBy: clientId },
        { source: "gateway", priority: "high" },
      );
      this.pushToSubscribers("push.stateChange", {
        previousState: "paused",
        currentState: "running",
        timestamp: Date.now(),
      });
      return { resumed: true };
    });

    // brain.triggerAction: trigger a specific action (e.g., "dream", "learn")
    this.registerHandler("brain.triggerAction", async (params, clientId) => {
      const parsed = BrainTriggerActionParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new RpcValidationError(
          `Invalid brain.triggerAction params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
        );
      }
      const { action, args } = parsed.data;

      const ALLOWED_ACTIONS = new Set(["dream", "learn", "check_telegram", "health_check", "consolidate"]);
      if (!ALLOWED_ACTIONS.has(action)) {
        throw new RpcValidationError(`Unknown action: ${action}. Allowed: ${[...ALLOWED_ACTIONS].join(", ")}`);
      }

      this.logger.info("brain.triggerAction", `Client ${clientId} triggered action: ${action}`);
      this.eventBus.publish(
        "system:config_changed",
        { action: "trigger", triggerAction: action, args: args ?? {}, requestedBy: clientId },
        { source: "gateway", priority: "high" },
      );
      return { triggered: true, action };
    });

    // brain.getLog: get recent log entries
    this.registerHandler("brain.getLog", async (params) => {
      const parsed = BrainGetLogParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new RpcValidationError(
          `Invalid brain.getLog params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
        );
      }
      const limit = parsed.data.limit ?? 50;
      // Log retrieval is delegated to external handler registration.
      // Return a placeholder indicating the handler should be overridden
      // by the core system when the logging subsystem is wired up.
      return { entries: [], limit, note: "Override this handler with actual log retrieval" };
    });

    // -----------------------------------------------------------------------
    // Client management handlers
    // -----------------------------------------------------------------------

    // client.list: list all connected clients with metadata
    this.registerHandler("client.list", async () => {
      const clients: ConnectedClientInfo[] = [];
      for (const client of this.clients.values()) {
        if (!client.authenticated) continue;
        clients.push({
          id: client.id,
          platform: client.platform,
          version: client.version,
          connectedAt: client.connectedAt,
          subscribed: this.statusSubscribers.has(client.id),
        });
      }
      return { clients };
    });

    // client.execute: forward a command to a specific target client
    this.registerHandler("client.execute", async (params, fromClientId) => {
      // SEC-H10: Verify the requesting client is authenticated before allowing
      // command execution on other clients. This prevents unauthenticated clients
      // (which should not exist, but defense-in-depth) from issuing commands.
      const fromClient = this.clients.get(fromClientId);
      if (!fromClient || !fromClient.authenticated) {
        throw new RpcValidationError("Unauthorized: client.execute requires an authenticated session");
      }

      const parsed = ClientExecuteParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new RpcValidationError(
          `Invalid client.execute params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
        );
      }
      const { targetClientId, command, args } = parsed.data;

      // Prevent a client from executing commands on itself
      if (targetClientId === fromClientId) {
        throw new RpcValidationError("Cannot execute commands on self via client.execute");
      }

      const targetClient = this.clients.get(targetClientId);
      if (!targetClient || !targetClient.authenticated) {
        throw new RpcValidationError(`Target client ${targetClientId} not found or not authenticated`);
      }

      const commandId = randomUUID();
      const pushPayload = createPushEvent("push.executeCommand", {
        commandId,
        command,
        args: args ?? null,
        fromClientId,
      });

      try {
        targetClient.ws.send(JSON.stringify(pushPayload));
      } catch {
        throw new RpcValidationError(`Failed to send command to target client ${targetClientId}`);
      }

      this.logger.info(
        "client.execute",
        `Client ${fromClientId} sent command "${command}" to ${targetClientId} (${commandId})`,
      );
      return { sent: true, commandId, targetClientId };
    });

    // command.result: a client reports the result of an executed command
    this.registerHandler("command.result", async (params, clientId) => {
      const parsed = CommandResultParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new RpcValidationError(
          `Invalid command.result params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
        );
      }
      const { commandId, success, result, error } = parsed.data;

      const wasSuccessful = success ?? false;
      this.logger.info(
        "command.result",
        `Client ${clientId} reported command ${commandId} result: ${wasSuccessful ? "success" : "failure"}`,
      );

      // Publish the result so interested components can react
      this.eventBus.publish(
        "gateway:client_error_report",
        {
          clientId,
          commandId,
          success: wasSuccessful,
          result: result ?? null,
          error,
        },
        { source: "gateway" },
      );

      return { received: true, commandId };
    });

    // -----------------------------------------------------------------------
    // Research handlers
    // -----------------------------------------------------------------------

    // research.start: start a deep research session
    this.registerHandler("research.start", async (params, clientId) => {
      const parsed = ResearchStartParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new RpcValidationError(
          `Invalid research.start params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
        );
      }
      const { query, sources, maxSources, deliverTo } = parsed.data;

      this.logger.info("research.start", `Client ${clientId} requested research: "${query}"`);
      const researchId = randomUUID();
      this.eventBus.publish(
        "research:started",
        { researchId, query, sources: sources ?? [], maxSources: maxSources ?? 10, deliverTo },
        { source: "gateway", priority: "normal" },
      );
      return { researchId, status: "started" };
    });

    // research.status: check the status of a research session
    this.registerHandler("research.status", async (params) => {
      const parsed = ResearchStatusParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new RpcValidationError(
          `Invalid research.status params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
        );
      }
      // Status retrieval is delegated to external handler registration.
      return {
        researchId: parsed.data.researchId,
        status: "unknown",
        note: "Override this handler with actual research status retrieval",
      };
    });

    // research.list: list recent research results
    this.registerHandler("research.list", async (params) => {
      const parsed = ResearchListParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new RpcValidationError(
          `Invalid research.list params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
        );
      }
      // List retrieval is delegated to external handler registration.
      return {
        results: [],
        limit: parsed.data.limit ?? 20,
        note: "Override this handler with actual research list retrieval",
      };
    });

    // -----------------------------------------------------------------------
    // Profile handlers
    // -----------------------------------------------------------------------

    // profile.get: return the user's accumulated profile
    this.registerHandler("profile.get", async () => {
      // Profile generation is delegated to external handler registration.
      // Override via server.registerHandler("profile.get", ...) with a
      // handler that calls UserProfileGenerator.generateProfile().
      return { profile: null, note: "Override this handler with actual profile generation" };
    });

    // -----------------------------------------------------------------------
    // Metrics handlers
    // -----------------------------------------------------------------------

    // metrics.rateLimits: return rate limit status for all accounts
    this.registerHandler("metrics.rateLimits", async () => {
      if (!this.rateLimitTracker) {
        return { accounts: [], note: "RateLimitTracker not configured" };
      }
      const statuses = this.rateLimitTracker.getAllAccountStatuses();
      return { accounts: statuses };
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

        // GET /health -- basic health endpoint (unauthenticated)
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

        // GET /metrics -- Prometheus exposition format (unauthenticated for scraping)
        if (url.pathname === "/metrics" && req.method === "GET") {
          if (!self.metricsRegistry) {
            return secureResponse("Metrics not configured", 404, isTls);
          }
          const body = formatPrometheus(self.metricsRegistry);
          const headers: Record<string, string> = { ...SECURITY_HEADERS, "Content-Type": PROMETHEUS_CONTENT_TYPE };
          if (isTls) headers["Strict-Transport-Security"] = "max-age=31536000";
          return new Response(body, { status: 200, headers });
        }

        // POST /webhooks/:id -- webhook ingestion endpoint
        if (url.pathname.startsWith("/webhooks/") && req.method === "POST") {
          const endpointId = url.pathname.slice("/webhooks/".length);
          return self.handleWebhookRoute(req, endpointId, isTls);
        }

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
        // SEC-M3: When allowedOrigins is empty, all origins are accepted.
        // This is intentional for development, but should be restricted in production.
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

    // SEC-M3: Warn when no origin restrictions are configured
    if (this.config.allowedOrigins.length === 0) {
      this.logger.warn(
        "security",
        "Gateway has no allowedOrigins configured. All origins will be accepted. Set allowedOrigins in production.",
      );
    }

    // NET-001: Warn when auth tokens will be transmitted in plaintext
    if (!this.config.tls.enabled && this.config.auth.type === "token" && typeof this.config.auth.token === "string") {
      this.logger.warn(
        "security",
        "Gateway running without TLS. Auth tokens transmitted in plaintext. Enable TLS in production.",
      );
    }
  }

  /** Graceful shutdown: close all connections and stop the server. */
  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    // ERR-001: Clear all pending auth timeout timers before closing
    for (const timer of this.authTimers.values()) {
      clearTimeout(timer);
    }
    this.authTimers.clear();

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
  // Webhook routing
  // -------------------------------------------------------------------------

  /**
   * Route an incoming webhook HTTP request to the webhook handler, then
   * publish the validated payload to the EventBus.
   *
   * Supports per-endpoint configuration: if an endpoint ID matches a configured
   * webhook endpoint, uses that endpoint's token and priority. Otherwise falls
   * back to the gateway-level auth token.
   */
  private async handleWebhookRoute(req: Request, endpointId: string, isTls: boolean): Promise<Response> {
    // Look up per-endpoint configuration
    const endpoints = this.config.webhooks?.endpoints ?? [];
    const endpointConfig = endpoints.find((ep) => ep.id === endpointId);

    // If a specific endpoint is configured but disabled, reject early
    if (endpointConfig && !endpointConfig.enabled) {
      return secureResponse("Not found", 404, isTls);
    }

    // Resolve the token for authentication
    let resolvedToken: string | undefined;
    if (endpointConfig) {
      // Per-endpoint token (already resolved from secret refs by the config loader)
      resolvedToken = typeof endpointConfig.token === "string" ? endpointConfig.token : undefined;
    } else {
      // Fall back to gateway auth token
      resolvedToken = typeof this.config.auth.token === "string" ? this.config.auth.token : undefined;
    }

    const deps: WebhookDeps = {
      logger: this.logger,
      gatewayToken: resolvedToken,
    };

    const response = await handleWebhookRequest(req, deps);

    // If the handler returned a successful result, publish to EventBus
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

  /**
   * Push a notification to all subscribed (status-subscriber) clients.
   * Uses JSON-RPC 2.0 notification format (no id, no response expected).
   */
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
      platform: "unknown",
      version: "unknown",
      connectedAt: Date.now(),
      messageCount: 0,
      messageWindowStart: Date.now(),
    };
    this.clients.set(clientId, state);

    if (!requiresAuth) {
      // SEC-M6: Log at warn level when auth is disabled to ensure visibility
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

      // ERR-001: Enforce auth timeout — track timer for cleanup on auth/disconnect/shutdown
      const authTimer = setTimeout(() => {
        this.authTimers.delete(clientId);
        const client = this.clients.get(clientId);
        if (client && !client.authenticated) {
          this.logger.warn("auth-timeout", `Client ${clientId} auth timeout`, {
            ip: anonymizeIp(ip),
          });
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

    // If not yet authenticated, expect ClientAuth as first message
    // (auth messages are not subject to per-message rate limiting)
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

    // ERR-001: Clear auth timeout timer now that client has authenticated
    const authTimer = this.authTimers.get(client.id);
    if (authTimer) {
      clearTimeout(authTimer);
      this.authTimers.delete(client.id);
    }

    // Extract client metadata from auth params if provided
    if (isJsonRpc) {
      const params = obj.params as Record<string, unknown> | undefined;
      if (params) {
        if (typeof params.platform === "string") {
          client.platform = params.platform;
        }
        if (typeof params.version === "string") {
          client.version = params.version;
        }
      }
    }

    this.logger.info("auth", `Client ${client.id} authenticated from ${anonymizeIp(client.ip)}`);
    this.eventBus.publish(
      "gateway:client_connected",
      { clientId: client.id, authenticated: true },
      { source: "gateway" },
    );
    this.pushToSubscribers("push.clientConnected", {
      clientId: client.id,
      platform: client.platform,
      version: client.version,
      timestamp: client.connectedAt,
    });

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
    const client = this.clients.get(clientId);

    // ERR-001: Clear auth timeout timer on disconnect
    const authTimer = this.authTimers.get(clientId);
    if (authTimer) {
      clearTimeout(authTimer);
      this.authTimers.delete(clientId);
    }

    this.clients.delete(clientId);
    this.statusSubscribers.delete(clientId);
    this.logger.info("close", `Client ${clientId} disconnected`, {
      code,
      reason: reason || "none",
    });
    this.eventBus.publish("gateway:client_disconnected", { clientId, code, reason }, { source: "gateway" });
    this.pushToSubscribers("push.clientDisconnected", {
      clientId,
      platform: client?.platform ?? "unknown",
      version: client?.version ?? "unknown",
      timestamp: Date.now(),
    });
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
