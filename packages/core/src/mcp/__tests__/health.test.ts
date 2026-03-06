import { describe, expect, test } from "bun:test";
import type { HealthCheck } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { McpServerConfig } from "../health.ts";
import { MCPHealthMonitor } from "../health.ts";

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

describe("MCPHealthMonitor", () => {
  const logger = createSilentLogger();

  test("initializes all statuses as unknown", () => {
    const servers: Record<string, McpServerConfig> = {
      "test-server": { command: "echo", args: ["hello"] },
      "another-server": { command: "echo", args: ["world"] },
    };
    const monitor = new MCPHealthMonitor(servers, logger);
    const statuses = monitor.getStatuses();

    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status.status).toBe("unknown");
      expect(status.lastCheckedAt).toBe(0);
    }
    monitor.dispose();
  });

  test("getStatus returns undefined for unknown server", () => {
    const monitor = new MCPHealthMonitor({}, logger);
    expect(monitor.getStatus("nonexistent")).toBeUndefined();
    monitor.dispose();
  });

  test("getStatus returns status for known server", () => {
    const servers: Record<string, McpServerConfig> = {
      "test-server": { command: "echo", args: ["hello"] },
    };
    const monitor = new MCPHealthMonitor(servers, logger);
    const status = monitor.getStatus("test-server");

    expect(status).toBeDefined();
    expect(status?.name).toBe("test-server");
    expect(status?.status).toBe("unknown");
    monitor.dispose();
  });

  test("checkServer marks a working command as healthy", async () => {
    const monitor = new MCPHealthMonitor({}, logger, { checkTimeoutMs: 5_000 });
    const config: McpServerConfig = { command: "echo", args: ["hello"] };

    const result = await monitor.checkServer("echo-test", config);

    expect(result.name).toBe("echo-test");
    expect(result.status).toBe("healthy");
    expect(result.lastCheckedAt).toBeGreaterThan(0);
    expect(result.responseTimeMs).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: test assertion
    expect(result.responseTimeMs!).toBeGreaterThanOrEqual(0);
    monitor.dispose();
  });

  test("checkServer marks a nonexistent command as unhealthy", async () => {
    const monitor = new MCPHealthMonitor({}, logger, { checkTimeoutMs: 2_000 });
    const config: McpServerConfig = {
      command: "nonexistent-command-that-does-not-exist-abc123xyz",
    };

    const result = await monitor.checkServer("bad-server", config);

    expect(result.name).toBe("bad-server");
    expect(result.status).toBe("unhealthy");
    expect(result.message).toBeDefined();
    monitor.dispose();
  });

  test("checkAll updates all server statuses", async () => {
    const servers: Record<string, McpServerConfig> = {
      "good-server": { command: "echo", args: ["ok"] },
      "bad-server": { command: "nonexistent-command-abc123xyz" },
    };
    const monitor = new MCPHealthMonitor(servers, logger, { checkTimeoutMs: 3_000 });

    const results = await monitor.checkAll();

    expect(results).toHaveLength(2);

    const good = results.find((r) => r.name === "good-server");
    const bad = results.find((r) => r.name === "bad-server");

    expect(good?.status).toBe("healthy");
    expect(bad?.status).toBe("unhealthy");

    // Verify statuses are cached
    const cachedGood = monitor.getStatus("good-server");
    expect(cachedGood?.status).toBe("healthy");
    monitor.dispose();
  });

  test("createHealthCheck returns pass when no servers configured", async () => {
    const monitor = new MCPHealthMonitor({}, logger);
    const check = monitor.createHealthCheck();
    const result: HealthCheck = await check();

    expect(result.name).toBe("mcp-servers");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("No MCP servers configured");
    monitor.dispose();
  });

  test("createHealthCheck returns warn when all statuses are unknown", async () => {
    const servers: Record<string, McpServerConfig> = {
      "test-server": { command: "echo", args: ["hello"] },
    };
    const monitor = new MCPHealthMonitor(servers, logger);
    const check = monitor.createHealthCheck();
    const result: HealthCheck = await check();

    expect(result.name).toBe("mcp-servers");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("not yet checked");
    monitor.dispose();
  });

  test("createHealthCheck returns pass when all servers are healthy", async () => {
    const servers: Record<string, McpServerConfig> = {
      "good-server": { command: "echo", args: ["ok"] },
    };
    const monitor = new MCPHealthMonitor(servers, logger, { checkTimeoutMs: 3_000 });

    // Run checks first to update statuses
    await monitor.checkAll();

    const check = monitor.createHealthCheck();
    const result: HealthCheck = await check();

    expect(result.name).toBe("mcp-servers");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("healthy");
    monitor.dispose();
  });

  test("createHealthCheck returns warn when some servers are unhealthy", async () => {
    const servers: Record<string, McpServerConfig> = {
      "good-server": { command: "echo", args: ["ok"] },
      "bad-server": { command: "nonexistent-command-abc123xyz" },
    };
    const monitor = new MCPHealthMonitor(servers, logger, { checkTimeoutMs: 3_000 });

    await monitor.checkAll();

    const check = monitor.createHealthCheck();
    const result: HealthCheck = await check();

    expect(result.name).toBe("mcp-servers");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("bad-server");
    monitor.dispose();
  });

  test("filters out $secret: references from env", async () => {
    const monitor = new MCPHealthMonitor({}, logger, { checkTimeoutMs: 3_000 });
    const config: McpServerConfig = {
      command: "echo",
      args: ["hello"],
      env: {
        NORMAL_VAR: "value",
        SECRET_VAR: "$secret:MY_SECRET",
      },
    };

    // Should not throw -- $secret: refs are filtered out
    const result = await monitor.checkServer("env-test", config);
    expect(result.status).toBe("healthy");
    monitor.dispose();
  });

  test("dispose stops periodic checks", () => {
    const servers: Record<string, McpServerConfig> = {
      "test-server": { command: "echo", args: ["hello"] },
    };
    const monitor = new MCPHealthMonitor(servers, logger, { checkIntervalMs: 100_000 });

    monitor.startPeriodic();
    // Should not throw
    monitor.dispose();
    // Double dispose should also not throw
    monitor.dispose();
  });
});
