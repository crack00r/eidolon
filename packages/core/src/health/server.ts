/**
 * Lightweight HTTP health check server using Bun.serve().
 *
 * Exposes three endpoints:
 * - GET /health       — full health status with checks array
 * - GET /health/ready — simple readiness probe { ready: boolean }
 * - GET /discovery    — server discovery info (service, version, hostname, gateway)
 *
 * Binds to 127.0.0.1 by default for security (internal use only).
 *
 * Security hardening (NET-005):
 * - Host header validation to prevent DNS rebinding attacks
 * - In-memory per-IP rate limiting (default: 60 req/min)
 */

import type { Logger } from "../logging/logger.ts";
import type { HealthChecker } from "./checker.ts";

// ---------------------------------------------------------------------------
// Rate limiter (simple in-memory, per-IP)
// ---------------------------------------------------------------------------

/** Maximum requests per IP per window. */
const RATE_LIMIT_MAX_REQUESTS = 60;

/** Rate limit window in milliseconds (1 minute). */
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimitBucket {
  count: number;
  windowStart: number;
}

/** Simple in-memory rate limiter for health server requests. */
class HealthRateLimiter {
  private readonly buckets: Map<string, RateLimitBucket> = new Map();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(maxRequests: number = RATE_LIMIT_MAX_REQUESTS, windowMs: number = RATE_LIMIT_WINDOW_MS) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    // Periodic cleanup to prevent memory leaks from stale entries
    this.cleanupTimer = setInterval(() => this.cleanup(), this.windowMs * 2);
    this.cleanupTimer.unref();
  }

  /** Check and consume a request for the given IP. Returns true if allowed, false if rate-limited. */
  allow(ip: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ip);

    if (!bucket || now - bucket.windowStart > this.windowMs) {
      this.buckets.set(ip, { count: 1, windowStart: now });
      return true;
    }

    bucket.count++;
    return bucket.count <= this.maxRequests;
  }

  /** Remove expired buckets. */
  private cleanup(): void {
    const now = Date.now();
    for (const [ip, bucket] of this.buckets) {
      if (now - bucket.windowStart > this.windowMs) {
        this.buckets.delete(ip);
      }
    }
  }

  /** Dispose of cleanup timer. */
  dispose(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.buckets.clear();
  }
}

// ---------------------------------------------------------------------------
// Allowed Host values for DNS rebinding protection
// ---------------------------------------------------------------------------

/** Host header values considered safe (loopback and common local names). */
const ALLOWED_HOST_PATTERNS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export interface DiscoveryInfo {
  readonly version: string;
  readonly hostname: string;
  readonly gateway: {
    readonly host: string;
    readonly port: number;
    readonly tls: boolean;
  };
}

export interface HealthServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly checker: HealthChecker;
  readonly logger: Logger;
  readonly discovery?: DiscoveryInfo;
  /** Additional hostnames to allow in Host header (beyond localhost/127.0.0.1). */
  readonly allowedHosts?: readonly string[];
}

export interface HealthServer {
  readonly port: number;
  start(): void;
  stop(): Promise<void>;
}

/**
 * Create a health check HTTP server.
 *
 * Call `.start()` to begin serving, `.stop()` to shut down.
 */
export function createHealthServer(options: HealthServerOptions): HealthServer {
  const { port, checker, logger: parentLogger, discovery } = options;
  const host = options.host ?? "127.0.0.1";
  const logger = parentLogger.child("health-server");
  const rateLimiter = new HealthRateLimiter();

  // Build the set of allowed Host header values
  const allowedHosts = new Set(ALLOWED_HOST_PATTERNS);
  // Also allow the configured bind host (with and without port)
  allowedHosts.add(host);
  allowedHosts.add(`${host}:${port}`);
  // Add any extra allowed hosts from options
  if (options.allowedHosts) {
    for (const h of options.allowedHosts) {
      allowedHosts.add(h.toLowerCase());
    }
  }

  let server: ReturnType<typeof Bun.serve> | undefined;

  function jsonResponse(body: unknown, status: number): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
        "X-Frame-Options": "DENY",
        "X-XSS-Protection": "0",
        "Content-Security-Policy": "default-src 'none'",
        "Referrer-Policy": "no-referrer",
      },
    });
  }

  async function handleHealth(): Promise<Response> {
    const result = await checker.check();

    const httpStatus = result.status === "unhealthy" ? 503 : 200;

    return jsonResponse(result, httpStatus);
  }

  async function handleReady(): Promise<Response> {
    const result = await checker.check();
    const ready = result.status !== "unhealthy";

    return jsonResponse({ ready }, ready ? 200 : 503);
  }

  function handleDiscovery(): Response {
    if (!discovery) {
      return jsonResponse({ error: "Discovery not configured" }, 404);
    }

    return jsonResponse(
      {
        service: "eidolon",
        version: discovery.version,
        hostname: discovery.hostname,
        gateway: discovery.gateway,
      },
      200,
    );
  }

  async function handleRequest(
    req: Request,
    bunServer: { requestIP(req: Request): { address: string } | null },
  ): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

    // NET-005: Host header validation to prevent DNS rebinding attacks
    const hostHeader = (req.headers.get("Host") ?? "").toLowerCase();
    // Strip port from host header for comparison
    const hostWithoutPort = hostHeader.replace(/:\d+$/, "");
    if (hostHeader && !allowedHosts.has(hostHeader) && !allowedHosts.has(hostWithoutPort)) {
      logger.warn("request", `Rejected request with unexpected Host header: ${hostHeader}`);
      return jsonResponse({ error: "Forbidden" }, 403);
    }

    // NET-005: Per-IP rate limiting
    const clientIp = bunServer.requestIP(req)?.address ?? "unknown";
    if (!rateLimiter.allow(clientIp)) {
      logger.debug("request", `Rate-limited request from ${clientIp}`);
      return jsonResponse({ error: "Too many requests" }, 429);
    }

    if (method !== "GET") {
      logger.debug("request", `Rejected ${method} ${pathname} — only GET allowed`);
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (pathname === "/health") {
      return handleHealth();
    }

    if (pathname === "/health/ready") {
      return handleReady();
    }

    if (pathname === "/discovery") {
      return handleDiscovery();
    }

    return jsonResponse({ error: "Not found" }, 404);
  }

  const healthServer: HealthServer = {
    get port(): number {
      return port;
    },

    start(): void {
      if (server) {
        logger.warn("start", "Health server already running");
        return;
      }

      server = Bun.serve({
        port,
        hostname: host,
        fetch(req, srv) {
          return handleRequest(req, srv);
        },
      });

      logger.info("start", `Health server listening on ${host}:${port}`);
    },

    async stop(): Promise<void> {
      if (!server) {
        return;
      }

      server.stop(true);
      server = undefined;
      rateLimiter.dispose();
      logger.info("stop", "Health server stopped");
    },
  };

  return healthServer;
}
