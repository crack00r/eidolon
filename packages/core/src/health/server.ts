/**
 * Lightweight HTTP health check server using Bun.serve().
 *
 * Exposes two endpoints:
 * - GET /health       — full health status with checks array
 * - GET /health/ready — simple readiness probe { ready: boolean }
 *
 * Binds to 127.0.0.1 by default for security (internal use only).
 */

import type { Logger } from "../logging/logger.ts";
import type { HealthChecker } from "./checker.ts";

export interface HealthServerOptions {
  readonly port: number;
  readonly host?: string;
  readonly checker: HealthChecker;
  readonly logger: Logger;
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
  const { port, checker, logger: parentLogger } = options;
  const host = options.host ?? "127.0.0.1";
  const logger = parentLogger.child("health-server");

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

  async function handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method;

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
        fetch: handleRequest,
      });

      logger.info("start", `Health server listening on ${host}:${port}`);
    },

    async stop(): Promise<void> {
      if (!server) {
        return;
      }

      server.stop(true);
      server = undefined;
      logger.info("stop", "Health server stopped");
    },
  };

  return healthServer;
}
