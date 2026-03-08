/**
 * ReplicationManager -- orchestrates primary/secondary replication.
 *
 * Responsibilities:
 * - Heartbeat exchange between nodes
 * - Automatic failover when primary goes down
 * - Manual promote/demote
 * - Periodic snapshot transfer
 *
 * Phase 1: Full DB snapshots every N minutes.
 * Phase 2: WAL streaming for near-realtime replication.
 */

import { createHmac } from "node:crypto";
import { hostname } from "node:os";
import type { DatabaseManager } from "../database/manager.ts";
import type { Logger } from "../logging/logger.ts";
import {
  createDemote,
  createHeartbeat,
  createHeartbeatAck,
  createPromote,
  createSnapshotEnd,
  createSnapshotStart,
  type ReplicationMessage,
} from "./protocol.ts";
import type { NodeRole, ReplicationConfig, ReplicationState } from "./schema.ts";
import { createInitialState } from "./schema.ts";
import {
  chunkSnapshotFile,
  cleanupOldSnapshots,
  createSnapshot,
  createSnapshotReceiver,
  type SnapshotReceiver,
} from "./snapshot.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum age for snapshot files (2x the snapshot interval). */
const SNAPSHOT_CLEANUP_MULTIPLIER = 2;

/** HMAC algorithm used for message authentication. */
const HMAC_ALGORITHM = "sha256";

// ---------------------------------------------------------------------------
// ReplicationManager
// ---------------------------------------------------------------------------

export class ReplicationManager {
  private readonly config: ReplicationConfig;
  private readonly dbManager: DatabaseManager;
  private readonly logger: Logger;
  private readonly nodeId: string;
  private readonly startTime: number;

  private state: ReplicationState;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotTimer: ReturnType<typeof setInterval> | null = null;
  private snapshotReceiver: SnapshotReceiver | null = null;
  private running = false;

  /** Callback invoked when a message needs to be sent to the peer. */
  private sendFn: ((msg: ReplicationMessage) => void) | null = null;

  constructor(config: ReplicationConfig, dbManager: DatabaseManager, logger: Logger) {
    this.config = config;
    this.dbManager = dbManager;
    this.logger = logger.child("replication");
    this.nodeId = `${hostname()}-${process.pid}`;
    this.startTime = Date.now();
    this.state = createInitialState(config.role);
  }

  /** Get current replication state (for health checks, status queries). */
  getState(): ReplicationState {
    return this.state;
  }

  /** Get this node's unique identifier. */
  getNodeId(): string {
    return this.nodeId;
  }

  /** Register the send function for outgoing messages. */
  setSendFunction(fn: (msg: ReplicationMessage) => void): void {
    this.sendFn = fn;
  }

  /** Start the replication manager (heartbeats + snapshot scheduling). */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Start heartbeat timer
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat();
      this.checkPeerTimeout();
    }, this.config.heartbeatIntervalMs);

    // Start snapshot timer (primary sends snapshots periodically)
    if (this.state.role === "primary") {
      this.startSnapshotTimer();
    }

    // Initialize snapshot receiver for secondary
    if (this.state.role === "secondary" && this.config.snapshotDir) {
      this.snapshotReceiver = createSnapshotReceiver(this.config.snapshotDir, this.logger);
    }

    this.logger.info("start", `Replication started as ${this.state.role}`, {
      nodeId: this.nodeId,
      peerAddress: this.config.peerAddress,
    });
  }

  /** Stop the replication manager. */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }

    this.logger.info("stop", "Replication stopped");
  }

  /**
   * Compute an HMAC signature for the given message JSON.
   * Returns empty string if no shared secret is configured.
   */
  computeHmac(json: string): string {
    if (!this.config.sharedSecret) return "";
    return createHmac(HMAC_ALGORITHM, this.config.sharedSecret).update(json).digest("hex");
  }

  /**
   * Verify an HMAC signature on a raw message JSON string.
   * Returns true if verification passes or if no shared secret is configured.
   */
  verifyHmac(json: string, hmac: string | undefined): boolean {
    if (!this.config.sharedSecret) return true;
    if (!hmac) {
      this.logger.warn("hmac", "Message missing HMAC signature");
      return false;
    }
    const expected = this.computeHmac(json);
    // Constant-time comparison to prevent timing attacks
    if (expected.length !== hmac.length) return false;
    let result = 0;
    for (let i = 0; i < expected.length; i++) {
      result |= (expected.charCodeAt(i) ?? 0) ^ (hmac.charCodeAt(i) ?? 0);
    }
    return result === 0;
  }

  /** Handle an incoming replication message from the peer. */
  handleMessage(msg: ReplicationMessage): void {
    switch (msg.type) {
      case "heartbeat":
        this.handleHeartbeat(msg);
        break;
      case "heartbeat_ack":
        this.updatePeerConnected(true);
        break;
      case "snapshot_start":
        this.handleSnapshotStart(msg.totalFiles, msg.totalBytes);
        break;
      case "snapshot_chunk":
        this.handleSnapshotChunk(msg.fileName, msg.chunkIndex, msg.totalChunks, msg.data);
        break;
      case "snapshot_end":
        this.handleSnapshotEnd(msg.checksums);
        break;
      case "promote":
        this.handlePromoteRequest();
        break;
      case "demote":
        this.handleDemoteRequest();
        break;
      case "snapshot_request":
        this.triggerSnapshot();
        break;
      case "error":
        this.logger.error("protocol", `Peer error: ${msg.errorCode} -- ${msg.errorMessage}`);
        break;
    }
  }

  /** Manually promote this node to primary. */
  promote(): void {
    if (this.state.role === "primary") {
      this.logger.warn("promote", "Already primary, ignoring promote request");
      return;
    }

    this.transitionRole("primary");
    this.startSnapshotTimer();

    // Notify peer to demote
    this.send(createDemote(this.nodeId));
    this.logger.info("promote", "Promoted to primary");
  }

  /** Manually demote this node to secondary. */
  demote(): void {
    if (this.state.role === "secondary") {
      this.logger.warn("demote", "Already secondary, ignoring demote request");
      return;
    }

    this.transitionRole("secondary");
    this.stopSnapshotTimer();

    // Initialize receiver
    if (this.config.snapshotDir) {
      this.snapshotReceiver = createSnapshotReceiver(this.config.snapshotDir, this.logger);
    }

    // Notify peer to promote
    this.send(createPromote(this.nodeId));
    this.logger.info("demote", "Demoted to secondary");
  }

  /** Trigger an immediate snapshot transfer. */
  triggerSnapshot(): void {
    if (this.state.role !== "primary") {
      this.logger.warn("snapshot", "Only primary can create snapshots");
      return;
    }

    if (this.state.snapshotInProgress) {
      this.logger.warn("snapshot", "Snapshot already in progress");
      return;
    }

    this.performSnapshot();
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private sendHeartbeat(): void {
    const uptime = Date.now() - this.startTime;
    this.send(createHeartbeat(this.nodeId, this.state.role, uptime));
  }

  private handleHeartbeat(msg: ReplicationMessage & { type: "heartbeat" }): void {
    this.updatePeerConnected(true);

    // Split-brain fencing: if both nodes believe they are primary,
    // the node with the higher failoverCount demotes itself.
    // On a tie, the node with the lexicographically higher nodeId demotes.
    if (msg.role === "primary" && this.state.role === "primary") {
      const peerNodeId = msg.nodeId;
      const shouldDemoteSelf =
        this.state.failoverCount > 0 || (this.state.failoverCount === 0 && this.nodeId > peerNodeId);

      if (shouldDemoteSelf) {
        this.logger.warn("split-brain", "Detected dual-primary, demoting self", {
          myFailoverCount: this.state.failoverCount,
          peerNodeId,
        });
        this.demote();
        return;
      }
      // Otherwise the peer should demote itself when it receives our heartbeat.
    }

    this.send(createHeartbeatAck(this.nodeId, this.state.role));
  }

  private checkPeerTimeout(): void {
    const { lastHeartbeatAt } = this.state;
    if (lastHeartbeatAt === null) return;

    const elapsed = Date.now() - lastHeartbeatAt;
    const threshold = this.config.heartbeatIntervalMs * this.config.missedHeartbeatsThreshold;

    if (elapsed > threshold && this.state.peerConnected) {
      this.updatePeerConnected(false);
      this.logger.warn("heartbeat", `Peer timeout after ${elapsed}ms`);

      // Auto-failover: secondary promotes itself when primary is down
      if (this.state.role === "secondary") {
        this.logger.info("failover", "Primary unreachable, auto-promoting to primary");
        this.autoPromote();
      }
    }
  }

  private autoPromote(): void {
    this.transitionRole("primary");
    this.startSnapshotTimer();
    this.state = {
      ...this.state,
      failoverCount: this.state.failoverCount + 1,
    };
    this.logger.info("failover", `Auto-failover complete (count: ${this.state.failoverCount})`);
  }

  private handlePromoteRequest(): void {
    if (this.state.role === "secondary") {
      this.transitionRole("primary");
      this.startSnapshotTimer();
      this.logger.info("promote", "Promoted to primary by peer request");
    }
  }

  private handleDemoteRequest(): void {
    if (this.state.role === "primary") {
      this.transitionRole("secondary");
      this.stopSnapshotTimer();
      if (this.config.snapshotDir) {
        this.snapshotReceiver = createSnapshotReceiver(this.config.snapshotDir, this.logger);
      }
      this.logger.info("demote", "Demoted to secondary by peer request");
    }
  }

  private handleSnapshotStart(totalFiles: number, totalBytes: number): void {
    if (!this.snapshotReceiver) {
      this.logger.warn("snapshot", "No snapshot receiver configured");
      return;
    }
    this.snapshotReceiver.begin(totalFiles, totalBytes);
    this.state = { ...this.state, snapshotInProgress: true };
  }

  private handleSnapshotChunk(fileName: string, chunkIndex: number, totalChunks: number, data: string): void {
    this.snapshotReceiver?.receiveChunk(fileName, chunkIndex, totalChunks, data);
  }

  private handleSnapshotEnd(checksums: Record<string, string>): void {
    if (!this.snapshotReceiver) return;

    const result = this.snapshotReceiver.finalize(checksums);
    this.state = {
      ...this.state,
      snapshotInProgress: false,
      lastSnapshotAt: result.ok ? Date.now() : this.state.lastSnapshotAt,
    };

    if (!result.ok) {
      this.logger.error("snapshot", `Snapshot verification failed: ${result.error.message}`);
    }
  }

  private performSnapshot(): void {
    const snapshotDir = this.config.snapshotDir || "/tmp/eidolon-snapshots";
    this.state = { ...this.state, snapshotInProgress: true };

    const snapResult = createSnapshot(this.dbManager, snapshotDir, this.logger);
    if (!snapResult.ok) {
      this.logger.error("snapshot", `Snapshot creation failed: ${snapResult.error.message}`);
      this.state = { ...this.state, snapshotInProgress: false };
      return;
    }

    const snap = snapResult.value;
    this.send(createSnapshotStart(this.nodeId, snap.files.length, snap.totalBytes));

    // Send chunks for each file
    const checksums: Record<string, string> = {};
    for (const file of snap.files) {
      const chunkResult = chunkSnapshotFile(file.path, file.fileName);
      if (!chunkResult.ok) {
        this.logger.error("snapshot", `Failed to chunk ${file.fileName}: ${chunkResult.error.message}`);
        continue;
      }

      checksums[file.fileName] = file.checksum;
      for (const chunk of chunkResult.value) {
        this.send({
          type: "snapshot_chunk",
          timestamp: Date.now(),
          nodeId: this.nodeId,
          fileName: chunk.fileName,
          chunkIndex: chunk.chunkIndex,
          totalChunks: chunk.totalChunks,
          data: chunk.data,
        });
      }
    }

    this.send(createSnapshotEnd(this.nodeId, checksums));
    this.state = {
      ...this.state,
      snapshotInProgress: false,
      lastSnapshotAt: Date.now(),
    };

    // Cleanup old snapshots
    cleanupOldSnapshots(snapshotDir, this.config.snapshotIntervalMs * SNAPSHOT_CLEANUP_MULTIPLIER, this.logger);
  }

  private transitionRole(newRole: NodeRole): void {
    this.state = { ...this.state, role: newRole };
  }

  private updatePeerConnected(connected: boolean): void {
    this.state = {
      ...this.state,
      peerConnected: connected,
      lastHeartbeatAt: connected ? Date.now() : this.state.lastHeartbeatAt,
    };
  }

  private startSnapshotTimer(): void {
    this.stopSnapshotTimer();
    this.snapshotTimer = setInterval(() => {
      this.performSnapshot();
    }, this.config.snapshotIntervalMs);
  }

  private stopSnapshotTimer(): void {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  private send(msg: ReplicationMessage): void {
    if (this.sendFn) {
      // HMAC is computed by the transport layer using computeHmac()
      // before serializing to the wire. The caller of handleMessage()
      // must verify HMAC via verifyHmac() before dispatching.
      this.sendFn(msg);
    }
  }
}
