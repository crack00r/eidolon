/**
 * Replication runtime state types.
 *
 * The config schema lives in @eidolon/protocol (ReplicationConfigSchema).
 * This module defines runtime state tracked by the ReplicationManager.
 */

import type { ReplicationConfig } from "@eidolon/protocol";

// Re-export the config type for convenience
export type { ReplicationConfig } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Node Role
// ---------------------------------------------------------------------------

export const NODE_ROLES = ["primary", "secondary"] as const;
export type NodeRole = (typeof NODE_ROLES)[number];

// ---------------------------------------------------------------------------
// Replication State
// ---------------------------------------------------------------------------

/** Runtime state of replication visible to health checks and status queries. */
export interface ReplicationState {
  readonly role: NodeRole;
  readonly peerConnected: boolean;
  readonly lastHeartbeatAt: number | null;
  readonly lastSnapshotAt: number | null;
  readonly snapshotInProgress: boolean;
  readonly failoverCount: number;
}

/** Initial replication state. */
export function createInitialState(role: NodeRole): ReplicationState {
  return {
    role,
    peerConnected: false,
    lastHeartbeatAt: null,
    lastSnapshotAt: null,
    snapshotInProgress: false,
    failoverCount: 0,
  };
}
