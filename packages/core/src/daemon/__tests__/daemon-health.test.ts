/**
 * Integration tests for daemon health: HealthChecker aggregation, individual checks,
 * and the health HTTP server endpoints.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthCheck, HealthStatus } from "@eidolon/protocol";
import { HealthChecker } from "../../health/checker.ts";
import { createBunCheck } from "../../health/checks/bun.ts";
import { createConfigCheck } from "../../health/checks/config.ts";
import { createHealthServer, type HealthServer } from "../../health/server.ts";
import type { Logger } from "../../logging/logger.ts";

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
  return async (): Promise<HealthCheck> => ({ name, status: "pass", message: "ok" });
}

function failCheck(name: string, message: string): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => ({ name, status: "fail", message });
}

const logger = createSilentLogger();

// ---------------------------------------------------------------------------
// HealthChecker integration tests
// ---------------------------------------------------------------------------

describe("HealthChecker runs all registered checks", () => {
  test("bun + config checks both present in results", async () => {
    const checker = new HealthChecker(logger);

    // Register the real bun check
    checker.register("bun", createBunCheck());

    // Create a valid temp config file for the config check
    const tmpDir = mkdtempSync(join(tmpdir(), "health-checker-"));
    const configPath = join(tmpDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ daemon: { enabled: true } }));

    try {
      checker.register("config", createConfigCheck(configPath));

      const result = await checker.check();

      // Both checks should be present
      expect(result.checks.length).toBeGreaterThanOrEqual(2);

      const names = result.checks.map((c) => c.name);
      expect(names).toContain("bun");
      expect(names).toContain("config");

      // Both should pass
      const bunCheck = result.checks.find((c) => c.name === "bun");
      const configCheck = result.checks.find((c) => c.name === "config");
      expect(bunCheck?.status).toBe("pass");
      expect(configCheck?.status).toBe("pass");

      expect(result.status).toBe("healthy");
      expect(result.timestamp).toBeNumber();
      expect(result.uptime).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("HealthChecker reports unhealthy on check failure", () => {
  test("custom failing check makes overall status unhealthy", async () => {
    const checker = new HealthChecker(logger);

    // One passing check
    checker.register("ok-service", passCheck("ok-service"));

    // One always-failing check
    checker.register("broken-service", failCheck("broken-service", "connection refused"));

    const result = await checker.check();

    expect(result.status).toBe("unhealthy");
    expect(result.checks).toHaveLength(2);

    const broken = result.checks.find((c) => c.name === "broken-service");
    expect(broken).toBeDefined();
    expect(broken?.status).toBe("fail");
    expect(broken?.message).toBe("connection refused");

    const ok = result.checks.find((c) => c.name === "ok-service");
    expect(ok?.status).toBe("pass");
  });
});

describe("Individual health checks", () => {
  test("bun check returns pass with valid version string", async () => {
    const check = createBunCheck();
    const result = await check();

    expect(result.name).toBe("bun");
    expect(result.status).toBe("pass");
    expect(result.message).toBeDefined();
    // Message should contain "Bun v" followed by a semver-like version
    expect(result.message).toMatch(/^Bun v\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// Health HTTP server integration tests
// ---------------------------------------------------------------------------

describe("Health server /health endpoint", () => {
  const activeServers: HealthServer[] = [];

  afterEach(async () => {
    for (const s of activeServers) {
      await s.stop();
    }
    activeServers.length = 0;
  });

  function startServer(
    checker: HealthChecker,
    opts?: { discovery?: Parameters<typeof createHealthServer>[0]["discovery"] },
  ): { server: HealthServer; base: string } {
    const port = randomPort();
    const server = createHealthServer({
      port,
      checker,
      logger,
      ...(opts?.discovery ? { discovery: opts.discovery } : {}),
    });
    server.start();
    activeServers.push(server);
    return { server, base: `http://127.0.0.1:${port}` };
  }

  test("responds to /health with JSON status", async () => {
    const checker = new HealthChecker(logger);
    checker.register("bun", createBunCheck());

    const { base } = startServer(checker);
    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as HealthStatus;
    expect(body.status).toBe("healthy");
    expect(body.timestamp).toBeNumber();
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.checks.length).toBeGreaterThanOrEqual(1);
  });

  test("returns 503 when a check fails", async () => {
    const checker = new HealthChecker(logger);
    checker.register("always-fail", failCheck("always-fail", "kaboom"));

    const { base } = startServer(checker);
    const res = await fetch(`${base}/health`);

    expect(res.status).toBe(503);

    const body = (await res.json()) as HealthStatus;
    expect(body.status).toBe("unhealthy");
  });
});

describe("Health server /discovery endpoint", () => {
  const activeServers: HealthServer[] = [];

  afterEach(async () => {
    for (const s of activeServers) {
      await s.stop();
    }
    activeServers.length = 0;
  });

  test("responds to /discovery with server info", async () => {
    const checker = new HealthChecker(logger);
    checker.register("bun", passCheck("bun"));

    const port = randomPort();
    const discovery = {
      version: "0.2.0",
      hostname: "integration-test-host",
      gateway: { host: "10.0.0.1", port: 8419, tls: true },
    };

    const server = createHealthServer({ port, checker, logger, discovery });
    server.start();
    activeServers.push(server);

    const res = await fetch(`http://127.0.0.1:${port}/discovery`);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.service).toBe("eidolon");
    expect(body.version).toBe("0.2.0");
    expect(body.hostname).toBe("integration-test-host");
    expect(body.gateway).toEqual({ host: "10.0.0.1", port: 8419, tls: true });
  });

  test("returns 404 when discovery is not configured", async () => {
    const checker = new HealthChecker(logger);

    const port = randomPort();
    const server = createHealthServer({ port, checker, logger });
    server.start();
    activeServers.push(server);

    const res = await fetch(`http://127.0.0.1:${port}/discovery`);

    expect(res.status).toBe(404);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Discovery not configured");
  });
});
