/**
 * Tests for the replication protocol messages.
 */

import { describe, expect, test } from "bun:test";
import {
  createDemote,
  createErrorMessage,
  createHeartbeat,
  createHeartbeatAck,
  createPromote,
  createSnapshotEnd,
  createSnapshotRequest,
  createSnapshotStart,
  parseReplicationMessage,
} from "../protocol.ts";

describe("ReplicationProtocol", () => {
  describe("message factories", () => {
    test("createHeartbeat produces valid heartbeat message", () => {
      const msg = createHeartbeat("node-1", "primary", 5000);
      expect(msg.type).toBe("heartbeat");
      expect(msg.nodeId).toBe("node-1");
      expect(msg.role).toBe("primary");
      expect(msg.uptime).toBe(5000);
      expect(msg.timestamp).toBeGreaterThan(0);
    });

    test("createHeartbeatAck produces valid ack message", () => {
      const msg = createHeartbeatAck("node-2", "secondary");
      expect(msg.type).toBe("heartbeat_ack");
      expect(msg.nodeId).toBe("node-2");
      expect(msg.role).toBe("secondary");
    });

    test("createSnapshotRequest produces valid request", () => {
      const msg = createSnapshotRequest("node-2");
      expect(msg.type).toBe("snapshot_request");
      expect(msg.nodeId).toBe("node-2");
    });

    test("createSnapshotStart produces valid start message", () => {
      const msg = createSnapshotStart("node-1", 3, 1024);
      expect(msg.type).toBe("snapshot_start");
      expect(msg.totalFiles).toBe(3);
      expect(msg.totalBytes).toBe(1024);
    });

    test("createSnapshotEnd produces valid end message", () => {
      const checksums = { "memory.db": "abc123", "operational.db": "def456" };
      const msg = createSnapshotEnd("node-1", checksums);
      expect(msg.type).toBe("snapshot_end");
      expect(msg.checksums).toEqual(checksums);
    });

    test("createPromote produces valid promote message", () => {
      const msg = createPromote("node-2");
      expect(msg.type).toBe("promote");
      expect(msg.nodeId).toBe("node-2");
    });

    test("createDemote produces valid demote message", () => {
      const msg = createDemote("node-1");
      expect(msg.type).toBe("demote");
      expect(msg.nodeId).toBe("node-1");
    });

    test("createErrorMessage produces valid error message", () => {
      const msg = createErrorMessage("node-1", "SNAPSHOT_FAILED", "Disk full");
      expect(msg.type).toBe("error");
      expect(msg.errorCode).toBe("SNAPSHOT_FAILED");
      expect(msg.errorMessage).toBe("Disk full");
    });
  });

  describe("parseReplicationMessage", () => {
    test("parses valid heartbeat JSON", () => {
      const msg = createHeartbeat("node-1", "primary", 1000);
      const result = parseReplicationMessage(JSON.stringify(msg));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe("heartbeat");
      }
    });

    test("parses valid snapshot_end JSON", () => {
      const msg = createSnapshotEnd("node-1", { "memory.db": "checksum" });
      const result = parseReplicationMessage(JSON.stringify(msg));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe("snapshot_end");
      }
    });

    test("rejects invalid JSON", () => {
      const result = parseReplicationMessage("not json");
      expect(result.ok).toBe(false);
    });

    test("rejects message with missing required fields", () => {
      const result = parseReplicationMessage(JSON.stringify({ type: "heartbeat" }));
      expect(result.ok).toBe(false);
    });

    test("rejects message with unknown type", () => {
      const result = parseReplicationMessage(
        JSON.stringify({ type: "unknown_type", timestamp: Date.now(), nodeId: "x" }),
      );
      expect(result.ok).toBe(false);
    });
  });
});
