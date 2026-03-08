/**
 * Tests for the ReplicationManager.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { ReplicationConfig } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { ReplicationManager } from "../manager.ts";
import type { ReplicationMessage } from "../protocol.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function makeLogger() {
  return createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 });
}

/** Minimal mock DatabaseManager that satisfies the type for constructor. */
function makeMockDbManager(): {
  memory: { exec: (sql: string) => void; query: (sql: string) => { get: () => unknown } };
  operational: { exec: (sql: string) => void; query: (sql: string) => { get: () => unknown } };
  audit: { exec: (sql: string) => void; query: (sql: string) => { get: () => unknown } };
} {
  const mockDb = {
    exec: (_sql: string) => {},
    query: (_sql: string) => ({ get: () => null }),
  };
  return { memory: mockDb, operational: mockDb, audit: mockDb } as unknown as ReturnType<typeof makeMockDbManager>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReplicationManager", () => {
  let sentMessages: ReplicationMessage[];

  beforeEach(() => {
    sentMessages = [];
  });

  function createManager(role: "primary" | "secondary" = "primary"): ReplicationManager {
    const config = makeConfig({ role });
    const dbManager = makeMockDbManager();
    const manager = new ReplicationManager(config, dbManager as never, makeLogger());
    manager.setSendFunction((msg) => sentMessages.push(msg));
    return manager;
  }

  test("starts with configured role", () => {
    const manager = createManager("primary");
    expect(manager.getState().role).toBe("primary");
    expect(manager.getState().peerConnected).toBe(false);
  });

  test("secondary starts with secondary role", () => {
    const manager = createManager("secondary");
    expect(manager.getState().role).toBe("secondary");
  });

  test("getNodeId returns non-empty string", () => {
    const manager = createManager();
    expect(manager.getNodeId().length).toBeGreaterThan(0);
  });

  test("start and stop lifecycle", () => {
    const manager = createManager();
    manager.start();
    manager.stop();
    // Should not throw on double stop
    manager.stop();
  });

  test("handleMessage processes heartbeat and sends ack", () => {
    const manager = createManager("secondary");
    manager.start();

    manager.handleMessage({
      type: "heartbeat",
      timestamp: Date.now(),
      nodeId: "peer-1",
      role: "primary",
      uptime: 5000,
    });

    expect(manager.getState().peerConnected).toBe(true);
    expect(manager.getState().lastHeartbeatAt).toBeGreaterThan(0);

    // Should have sent a heartbeat_ack
    const ack = sentMessages.find((m) => m.type === "heartbeat_ack");
    expect(ack).toBeDefined();

    manager.stop();
  });

  test("handleMessage processes heartbeat_ack", () => {
    const manager = createManager("primary");
    manager.start();

    manager.handleMessage({
      type: "heartbeat_ack",
      timestamp: Date.now(),
      nodeId: "peer-2",
      role: "secondary",
    });

    expect(manager.getState().peerConnected).toBe(true);
    manager.stop();
  });

  test("promote changes role from secondary to primary", () => {
    const manager = createManager("secondary");
    manager.start();

    manager.promote();

    expect(manager.getState().role).toBe("primary");

    // Should have sent a demote message to peer
    const demoteMsg = sentMessages.find((m) => m.type === "demote");
    expect(demoteMsg).toBeDefined();

    manager.stop();
  });

  test("promote is no-op when already primary", () => {
    const manager = createManager("primary");
    manager.start();

    manager.promote();

    expect(manager.getState().role).toBe("primary");
    const demoteMsg = sentMessages.find((m) => m.type === "demote");
    expect(demoteMsg).toBeUndefined();

    manager.stop();
  });

  test("demote changes role from primary to secondary", () => {
    const manager = createManager("primary");
    manager.start();

    manager.demote();

    expect(manager.getState().role).toBe("secondary");

    // Should have sent a promote message to peer
    const promoteMsg = sentMessages.find((m) => m.type === "promote");
    expect(promoteMsg).toBeDefined();

    manager.stop();
  });

  test("demote is no-op when already secondary", () => {
    const manager = createManager("secondary");
    manager.start();

    manager.demote();

    expect(manager.getState().role).toBe("secondary");
    const promoteMsg = sentMessages.find((m) => m.type === "promote");
    expect(promoteMsg).toBeUndefined();

    manager.stop();
  });

  test("handleMessage promote request promotes secondary", () => {
    const manager = createManager("secondary");
    manager.start();

    manager.handleMessage({
      type: "promote",
      timestamp: Date.now(),
      nodeId: "peer-1",
    });

    expect(manager.getState().role).toBe("primary");
    manager.stop();
  });

  test("handleMessage demote request demotes primary", () => {
    const manager = createManager("primary");
    manager.start();

    manager.handleMessage({
      type: "demote",
      timestamp: Date.now(),
      nodeId: "peer-2",
    });

    expect(manager.getState().role).toBe("secondary");
    manager.stop();
  });

  test("handleMessage error is logged without crash", () => {
    const manager = createManager("primary");
    manager.start();

    // Should not throw
    manager.handleMessage({
      type: "error",
      timestamp: Date.now(),
      nodeId: "peer-1",
      errorCode: "TEST_ERROR",
      errorMessage: "Something went wrong",
    });

    manager.stop();
  });

  test("initial state has zero failover count", () => {
    const manager = createManager("secondary");
    expect(manager.getState().failoverCount).toBe(0);
  });

  test("initial state has null timestamps", () => {
    const manager = createManager();
    expect(manager.getState().lastHeartbeatAt).toBeNull();
    expect(manager.getState().lastSnapshotAt).toBeNull();
  });
});
