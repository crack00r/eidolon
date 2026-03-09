/**
 * Tests for replication health check integration.
 */

import { describe, expect, test } from "bun:test";
import type { ReplicationConfig } from "@eidolon/protocol";
import { HealthChecker } from "../../health/checker.ts";
import { createLogger } from "../../logging/logger.ts";
import { getReplicationStatusSummary, registerReplicationHealthCheck } from "../health.ts";
import { ReplicationManager } from "../manager.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 });
}

function makeConfig(overrides?: Partial<ReplicationConfig>): ReplicationConfig {
  return {
    enabled: true,
    role: "primary",
    peerAddress: "100.64.0.2:9820",
    listenPort: 9820,
    heartbeatIntervalMs: 1000,
    missedHeartbeatsThreshold: 3,
    snapshotIntervalMs: 300_000,
    snapshotDir: "",
    sharedSecret: "",
    ...overrides,
  };
}

function makeMockDbManager() {
  const mockDb = {
    exec: (_sql: string) => {},
    query: (_sql: string) => ({ get: () => null }),
  };
  return { memory: mockDb, operational: mockDb, audit: mockDb };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Replication Health", () => {
  test("registers health check that reports peer disconnected as warn", async () => {
    const logger = makeLogger();
    const checker = new HealthChecker(logger);
    const manager = new ReplicationManager(makeConfig(), makeMockDbManager() as never, logger);

    registerReplicationHealthCheck(checker, manager, 300_000);

    const status = await checker.check();
    const replCheck = status.checks.find((c) => c.name === "replication");

    expect(replCheck).toBeDefined();
    expect(replCheck?.status).toBe("warn");
    expect(replCheck?.message).toContain("Peer disconnected");

    checker.dispose();
  });

  test("reports pass when peer is connected", async () => {
    const logger = makeLogger();
    const checker = new HealthChecker(logger);
    const manager = new ReplicationManager(makeConfig(), makeMockDbManager() as never, logger);

    // Simulate peer connection by handling a heartbeat
    manager.setSendFunction(() => {});
    manager.start();
    manager.handleMessage({
      type: "heartbeat",
      timestamp: Date.now(),
      nodeId: "peer-1",
      role: "secondary",
      uptime: 1000,
      failoverCount: 0,
    });

    registerReplicationHealthCheck(checker, manager, 300_000);

    const status = await checker.check();
    const replCheck = status.checks.find((c) => c.name === "replication");

    expect(replCheck).toBeDefined();
    expect(replCheck?.status).toBe("pass");
    expect(replCheck?.message).toContain("healthy");

    manager.stop();
    checker.dispose();
  });

  test("getReplicationStatusSummary returns all fields", () => {
    const logger = makeLogger();
    const manager = new ReplicationManager(makeConfig(), makeMockDbManager() as never, logger);

    const summary = getReplicationStatusSummary(manager);

    expect(summary.role).toBe("primary");
    expect(summary.peerConnected).toBe(false);
    expect(summary.lastHeartbeatAt).toBeNull();
    expect(summary.lastSnapshotAt).toBeNull();
    expect(summary.snapshotInProgress).toBe(false);
    expect(summary.failoverCount).toBe(0);
    expect(typeof summary.nodeId).toBe("string");
  });
});
