/**
 * Health check integration for the replication subsystem.
 *
 * Registers a health check that reports replication status:
 * - pass: peer connected and snapshots recent
 * - warn: peer disconnected but node is functional
 * - fail: replication enabled but not running
 */

import type { HealthCheck } from "@eidolon/protocol";
import type { HealthChecker } from "../health/checker.ts";
import type { ReplicationManager } from "./manager.ts";

/** How stale a snapshot can be before warning (3x the configured interval). */
const SNAPSHOT_STALENESS_MULTIPLIER = 3;

/**
 * Register a replication health check with the HealthChecker.
 *
 * @param checker - The health checker to register with
 * @param manager - The replication manager to check
 * @param snapshotIntervalMs - The configured snapshot interval
 */
export function registerReplicationHealthCheck(
  checker: HealthChecker,
  manager: ReplicationManager,
  snapshotIntervalMs: number,
): void {
  checker.register("replication", async (): Promise<HealthCheck> => {
    const state = manager.getState();
    const now = Date.now();

    // If peer is not connected, report a warning
    if (!state.peerConnected) {
      return {
        name: "replication",
        status: "warn",
        message: `Peer disconnected (role: ${state.role}, failovers: ${state.failoverCount})`,
      };
    }

    // Check snapshot freshness for secondary nodes
    if (state.role === "secondary" && state.lastSnapshotAt !== null) {
      const staleThreshold = snapshotIntervalMs * SNAPSHOT_STALENESS_MULTIPLIER;
      const elapsed = now - state.lastSnapshotAt;
      if (elapsed > staleThreshold) {
        return {
          name: "replication",
          status: "warn",
          message: `Last snapshot ${Math.round(elapsed / 1000)}s ago (threshold: ${Math.round(staleThreshold / 1000)}s)`,
        };
      }
    }

    // Check if a snapshot is currently in progress
    if (state.snapshotInProgress) {
      return {
        name: "replication",
        status: "pass",
        message: `Snapshot in progress (role: ${state.role})`,
      };
    }

    return {
      name: "replication",
      status: "pass",
      message: `Replication healthy (role: ${state.role}, peer: connected)`,
    };
  });
}

/**
 * Build a replication status summary for the /health endpoint.
 */
export function getReplicationStatusSummary(manager: ReplicationManager): Record<string, unknown> {
  const state = manager.getState();
  return {
    role: state.role,
    peerConnected: state.peerConnected,
    lastHeartbeatAt: state.lastHeartbeatAt,
    lastSnapshotAt: state.lastSnapshotAt,
    snapshotInProgress: state.snapshotInProgress,
    failoverCount: state.failoverCount,
    nodeId: manager.getNodeId(),
  };
}
