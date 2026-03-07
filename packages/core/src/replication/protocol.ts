/**
 * Replication protocol messages and WebSocket handling.
 *
 * Defines all messages exchanged between primary and secondary nodes:
 * heartbeat, snapshot_request, snapshot_chunk, promote, demote, ack.
 *
 * All messages are JSON-encoded with Zod validation.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Message Types
// ---------------------------------------------------------------------------

export const REPLICATION_MESSAGE_TYPES = [
  "heartbeat",
  "heartbeat_ack",
  "snapshot_request",
  "snapshot_start",
  "snapshot_chunk",
  "snapshot_end",
  "promote",
  "demote",
  "error",
] as const;

export type ReplicationMessageType = (typeof REPLICATION_MESSAGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Message Schemas
// ---------------------------------------------------------------------------

const BaseMessageSchema = z.object({
  type: z.enum(REPLICATION_MESSAGE_TYPES),
  timestamp: z.number(),
  nodeId: z.string().min(1),
});

export const HeartbeatMessageSchema = BaseMessageSchema.extend({
  type: z.literal("heartbeat"),
  role: z.enum(["primary", "secondary"]),
  uptime: z.number().nonnegative(),
});

export const HeartbeatAckMessageSchema = BaseMessageSchema.extend({
  type: z.literal("heartbeat_ack"),
  role: z.enum(["primary", "secondary"]),
});

export const SnapshotRequestMessageSchema = BaseMessageSchema.extend({
  type: z.literal("snapshot_request"),
});

export const SnapshotStartMessageSchema = BaseMessageSchema.extend({
  type: z.literal("snapshot_start"),
  /** Total number of database files in this snapshot. */
  totalFiles: z.number().int().positive(),
  /** Total size in bytes across all files. */
  totalBytes: z.number().int().nonnegative(),
});

export const SnapshotChunkMessageSchema = BaseMessageSchema.extend({
  type: z.literal("snapshot_chunk"),
  /** Which database file: memory.db, operational.db, audit.db. */
  fileName: z.string().min(1),
  /** Chunk index (0-based). */
  chunkIndex: z.number().int().nonnegative(),
  /** Total chunks for this file. */
  totalChunks: z.number().int().positive(),
  /** Base64-encoded chunk data. */
  data: z.string(),
});

export const SnapshotEndMessageSchema = BaseMessageSchema.extend({
  type: z.literal("snapshot_end"),
  /** SHA-256 checksums for each database file. */
  checksums: z.record(z.string(), z.string()),
});

export const PromoteMessageSchema = BaseMessageSchema.extend({
  type: z.literal("promote"),
});

export const DemoteMessageSchema = BaseMessageSchema.extend({
  type: z.literal("demote"),
});

export const ErrorMessageSchema = BaseMessageSchema.extend({
  type: z.literal("error"),
  errorCode: z.string(),
  errorMessage: z.string(),
});

// ---------------------------------------------------------------------------
// Union Message Schema
// ---------------------------------------------------------------------------

export const ReplicationMessageSchema = z.discriminatedUnion("type", [
  HeartbeatMessageSchema,
  HeartbeatAckMessageSchema,
  SnapshotRequestMessageSchema,
  SnapshotStartMessageSchema,
  SnapshotChunkMessageSchema,
  SnapshotEndMessageSchema,
  PromoteMessageSchema,
  DemoteMessageSchema,
  ErrorMessageSchema,
]);

export type ReplicationMessage = z.infer<typeof ReplicationMessageSchema>;
export type HeartbeatMessage = z.infer<typeof HeartbeatMessageSchema>;
export type HeartbeatAckMessage = z.infer<typeof HeartbeatAckMessageSchema>;
export type SnapshotRequestMessage = z.infer<typeof SnapshotRequestMessageSchema>;
export type SnapshotStartMessage = z.infer<typeof SnapshotStartMessageSchema>;
export type SnapshotChunkMessage = z.infer<typeof SnapshotChunkMessageSchema>;
export type SnapshotEndMessage = z.infer<typeof SnapshotEndMessageSchema>;
export type PromoteMessage = z.infer<typeof PromoteMessageSchema>;
export type DemoteMessage = z.infer<typeof DemoteMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;

// ---------------------------------------------------------------------------
// Message Factories
// ---------------------------------------------------------------------------

export function createHeartbeat(nodeId: string, role: "primary" | "secondary", uptime: number): HeartbeatMessage {
  return { type: "heartbeat", timestamp: Date.now(), nodeId, role, uptime };
}

export function createHeartbeatAck(nodeId: string, role: "primary" | "secondary"): HeartbeatAckMessage {
  return { type: "heartbeat_ack", timestamp: Date.now(), nodeId, role };
}

export function createSnapshotRequest(nodeId: string): SnapshotRequestMessage {
  return { type: "snapshot_request", timestamp: Date.now(), nodeId };
}

export function createSnapshotStart(nodeId: string, totalFiles: number, totalBytes: number): SnapshotStartMessage {
  return { type: "snapshot_start", timestamp: Date.now(), nodeId, totalFiles, totalBytes };
}

export function createSnapshotChunk(
  nodeId: string,
  fileName: string,
  chunkIndex: number,
  totalChunks: number,
  data: string,
): SnapshotChunkMessage {
  return { type: "snapshot_chunk", timestamp: Date.now(), nodeId, fileName, chunkIndex, totalChunks, data };
}

export function createSnapshotEnd(nodeId: string, checksums: Record<string, string>): SnapshotEndMessage {
  return { type: "snapshot_end", timestamp: Date.now(), nodeId, checksums };
}

export function createPromote(nodeId: string): PromoteMessage {
  return { type: "promote", timestamp: Date.now(), nodeId };
}

export function createDemote(nodeId: string): DemoteMessage {
  return { type: "demote", timestamp: Date.now(), nodeId };
}

export function createErrorMessage(nodeId: string, errorCode: string, errorMessage: string): ErrorMessage {
  return { type: "error", timestamp: Date.now(), nodeId, errorCode, errorMessage };
}

// ---------------------------------------------------------------------------
// Parse helper
// ---------------------------------------------------------------------------

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

/** Parse a raw JSON string into a validated ReplicationMessage. */
export function parseReplicationMessage(raw: string): Result<ReplicationMessage, EidolonError> {
  try {
    const json: unknown = JSON.parse(raw);
    const result = ReplicationMessageSchema.safeParse(json);
    if (!result.success) {
      return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, `Invalid replication message: ${result.error.message}`));
    }
    return Ok(result.data);
  } catch (cause) {
    return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, "Failed to parse replication message JSON", cause));
  }
}
