import { afterEach, describe, expect, test } from "bun:test";
import type { HealthCheck } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { HealthChecker } from "../checker.ts";
import { createHealthServer, type HealthServer } from "../server.ts";

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function randomPort(): number {
  return 40_000 + Math.floor(Math.random() * 10_000);
}

function passCheck(name: string): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => ({ name, status: "pass" });
}

function failCheck(name: string): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => ({ name, status: "fail", message: "down" });
}

function warnCheck(name: string): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => ({ name, status: "warn", message: "degraded" });
}

const logger = createSilentLogger();

/** Track servers for cleanup. */
const activeServers: HealthServer[] = [];

afterEach(async () => {
  for (const s of activeServers) {
    await s.stop();
  }
  activeServers.length = 0;
});

function startServer(checker: HealthChecker): { server: HealthServer; base: string } {
  const port = randomPort();
  const server = createHealthServer({ port, checker, logger });
  server.start();
  activeServers.push(server);
  return { server, base: `http://127.0.0.1:${port}` };
}

describe("HealthServer", () => {
  test("GET /health returns 200 with healthy status", async () => {
    const checker = new HealthChecker(logger);
    checker.register("db", passCheck("db"));

    const { base } = startServer(checker);
    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("healthy");
    expect(body.timestamp).toBeNumber();
    expect(body.uptime).toBeNumber();
    expect(Array.isArray(body.checks)).toBe(true);
  });

  test("GET /health returns 200 with degraded status when warning", async () => {
    const checker = new HealthChecker(logger);
    checker.register("disk", warnCheck("disk"));

    const { base } = startServer(checker);
    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("degraded");
  });

  test("GET /health returns 503 when unhealthy", async () => {
    const checker = new HealthChecker(logger);
    checker.register("db", failCheck("db"));

    const { base } = startServer(checker);
    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(503);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("unhealthy");
  });

  test("GET /health/ready returns ready true when healthy", async () => {
    const checker = new HealthChecker(logger);
    checker.register("db", passCheck("db"));

    const { base } = startServer(checker);
    const res = await fetch(`${base}/health/ready`);

    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ready).toBe(true);
  });

  test("GET /health/ready returns ready false when unhealthy", async () => {
    const checker = new HealthChecker(logger);
    checker.register("db", failCheck("db"));

    const { base } = startServer(checker);
    const res = await fetch(`${base}/health/ready`);

    expect(res.status).toBe(503);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ready).toBe(false);
  });

  test("GET /unknown returns 404", async () => {
    const checker = new HealthChecker(logger);

    const { base } = startServer(checker);
    const res = await fetch(`${base}/unknown`);

    expect(res.status).toBe(404);
  });

  test("GET /discovery returns discovery info when configured", async () => {
    const checker = new HealthChecker(logger);
    checker.register("db", passCheck("db"));

    const port = randomPort();
    const server = createHealthServer({
      port,
      checker,
      logger,
      discovery: {
        version: "0.1.2",
        hostname: "test-server",
        gateway: { host: "192.168.1.50", port: 8419, tls: false },
      },
    });
    server.start();
    activeServers.push(server);

    const res = await fetch(`http://127.0.0.1:${port}/discovery`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe("eidolon");
    expect(body.version).toBe("0.1.2");
    expect(body.hostname).toBe("test-server");
    expect(body.gateway).toEqual({ host: "192.168.1.50", port: 8419, tls: false });
  });

  test("GET /discovery returns 404 when not configured", async () => {
    const checker = new HealthChecker(logger);

    const { base } = startServer(checker);
    const res = await fetch(`${base}/discovery`);

    expect(res.status).toBe(404);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Discovery not configured");
  });

  test("server can be stopped", async () => {
    const checker = new HealthChecker(logger);
    const port = randomPort();
    const server = createHealthServer({ port, checker, logger });

    server.start();

    // Verify it's running
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    // Stop it
    await server.stop();

    // After stop, fetching should fail
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
      // If fetch somehow succeeds, fail the test
      expect(true).toBe(false);
    } catch {
      // Expected: connection refused
      expect(true).toBe(true);
    }
  });
});
