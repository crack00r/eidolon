/**
 * Tests for replication schema and state management.
 */

import { describe, expect, test } from "bun:test";
import { ReplicationConfigSchema } from "@eidolon/protocol";
import { createInitialState, NODE_ROLES } from "../schema.ts";

describe("ReplicationSchema", () => {
  describe("ReplicationConfigSchema", () => {
    test("parses valid config with defaults", () => {
      const result = ReplicationConfigSchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(false);
        expect(result.data.role).toBe("primary");
        expect(result.data.peerAddress).toBe("");
        expect(result.data.listenPort).toBe(9820);
        expect(result.data.heartbeatIntervalMs).toBe(5_000);
        expect(result.data.missedHeartbeatsThreshold).toBe(3);
        expect(result.data.snapshotIntervalMs).toBe(300_000);
        expect(result.data.snapshotDir).toBe("");
      }
    });

    test("parses full config", () => {
      const result = ReplicationConfigSchema.safeParse({
        enabled: true,
        role: "secondary",
        peerAddress: "100.64.0.1:9820",
        listenPort: 9821,
        heartbeatIntervalMs: 2000,
        missedHeartbeatsThreshold: 5,
        snapshotIntervalMs: 60_000,
        snapshotDir: "/tmp/snapshots",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.enabled).toBe(true);
        expect(result.data.role).toBe("secondary");
        expect(result.data.peerAddress).toBe("100.64.0.1:9820");
        expect(result.data.listenPort).toBe(9821);
      }
    });

    test("rejects invalid role", () => {
      const result = ReplicationConfigSchema.safeParse({ role: "invalid" });
      expect(result.success).toBe(false);
    });

    test("rejects negative heartbeat interval", () => {
      const result = ReplicationConfigSchema.safeParse({ heartbeatIntervalMs: -1 });
      expect(result.success).toBe(false);
    });

    test("rejects port out of range", () => {
      const result = ReplicationConfigSchema.safeParse({ listenPort: 0 });
      expect(result.success).toBe(false);
    });

    test("rejects port above 65535", () => {
      const result = ReplicationConfigSchema.safeParse({ listenPort: 70000 });
      expect(result.success).toBe(false);
    });
  });

  describe("NODE_ROLES", () => {
    test("contains primary and secondary", () => {
      expect(NODE_ROLES).toContain("primary");
      expect(NODE_ROLES).toContain("secondary");
      expect(NODE_ROLES).toHaveLength(2);
    });
  });

  describe("createInitialState", () => {
    test("creates state with primary role", () => {
      const state = createInitialState("primary");
      expect(state.role).toBe("primary");
      expect(state.peerConnected).toBe(false);
      expect(state.lastHeartbeatAt).toBeNull();
      expect(state.lastSnapshotAt).toBeNull();
      expect(state.snapshotInProgress).toBe(false);
      expect(state.failoverCount).toBe(0);
    });

    test("creates state with secondary role", () => {
      const state = createInitialState("secondary");
      expect(state.role).toBe("secondary");
    });
  });
});
