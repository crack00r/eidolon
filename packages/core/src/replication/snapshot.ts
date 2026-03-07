/**
 * Snapshot-based database replication (Phase 1).
 *
 * Periodically creates full copies of all 3 SQLite databases using
 * VACUUM INTO for consistent snapshots. Transfers them as base64 chunks
 * over the replication protocol.
 *
 * Phase 2 will add incremental WAL streaming.
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import {
  AUDIT_DB_FILENAME,
  createError,
  Err,
  ErrorCode,
  MEMORY_DB_FILENAME,
  Ok,
  OPERATIONAL_DB_FILENAME,
} from "@eidolon/protocol";
import type { DatabaseManager } from "../database/manager.ts";
import type { Logger } from "../logging/logger.ts";

/** Maximum chunk size in bytes for snapshot transfer (256 KB). */
const CHUNK_SIZE = 256 * 1024;

/** Database filenames to replicate. */
export const REPLICATED_DB_FILES = [MEMORY_DB_FILENAME, OPERATIONAL_DB_FILENAME, AUDIT_DB_FILENAME] as const;

/** Restrictive file permissions for snapshot files (owner read/write only). */
const SNAPSHOT_FILE_PERMISSIONS = 0o600;

// ---------------------------------------------------------------------------
// Snapshot Creation (Primary)
// ---------------------------------------------------------------------------

export interface SnapshotFile {
  readonly fileName: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly checksum: string;
}

export interface SnapshotResult {
  readonly files: readonly SnapshotFile[];
  readonly totalBytes: number;
  readonly createdAt: number;
}

interface DbEntry {
  readonly name: string;
  readonly fileName: string;
  readonly db: Database;
}

/**
 * Create consistent snapshots of all 3 databases using VACUUM INTO.
 * Returns paths to the snapshot files and their checksums.
 */
export function createSnapshot(
  dbManager: DatabaseManager,
  snapshotDir: string,
  logger: Logger,
): Result<SnapshotResult, EidolonError> {
  try {
    if (!existsSync(snapshotDir)) {
      mkdirSync(snapshotDir, { recursive: true });
    }

    const timestamp = Date.now();
    const files: SnapshotFile[] = [];
    let totalBytes = 0;

    const databases: readonly DbEntry[] = [
      { name: "memory", fileName: MEMORY_DB_FILENAME, db: dbManager.memory },
      { name: "operational", fileName: OPERATIONAL_DB_FILENAME, db: dbManager.operational },
      { name: "audit", fileName: AUDIT_DB_FILENAME, db: dbManager.audit },
    ];

    for (const { name, fileName, db } of databases) {
      const snapshotPath = join(snapshotDir, `${timestamp}_${fileName}`);

      // Validate path against injection
      if (snapshotPath.includes("'") || snapshotPath.includes("\0")) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Invalid snapshot path: ${snapshotPath}`));
      }

      // Use VACUUM INTO for a consistent point-in-time copy
      db.exec(`VACUUM INTO '${snapshotPath}'`);

      // Set restrictive permissions
      try {
        chmodSync(snapshotPath, SNAPSHOT_FILE_PERMISSIONS);
      } catch {
        // Non-fatal on some filesystems
      }

      // Calculate checksum
      const data = readFileSync(snapshotPath);
      const checksum = createHash("sha256").update(data).digest("hex");
      const sizeBytes = data.length;
      totalBytes += sizeBytes;

      files.push({ fileName, path: snapshotPath, sizeBytes, checksum });
      logger.debug("snapshot", `Created snapshot for ${name}: ${sizeBytes} bytes`);
    }

    logger.info("snapshot", `Snapshot created: ${files.length} files, ${totalBytes} bytes total`);
    return Ok({ files, totalBytes, createdAt: timestamp });
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create database snapshot", cause));
  }
}

// ---------------------------------------------------------------------------
// Snapshot Chunking (Primary -> Secondary transfer)
// ---------------------------------------------------------------------------

export interface ChunkInfo {
  readonly fileName: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly data: string; // base64
}

/** Split a snapshot file into base64-encoded chunks for transfer. */
export function chunkSnapshotFile(filePath: string, fileName: string): Result<readonly ChunkInfo[], EidolonError> {
  try {
    const data = readFileSync(filePath);
    const totalChunks = Math.max(1, Math.ceil(data.length / CHUNK_SIZE));
    const chunks: ChunkInfo[] = [];

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, data.length);
      const chunkData = Buffer.from(data.subarray(start, end)).toString("base64");
      chunks.push({ fileName, chunkIndex: i, totalChunks, data: chunkData });
    }

    return Ok(chunks);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to chunk snapshot file: ${filePath}`, cause));
  }
}

// ---------------------------------------------------------------------------
// Snapshot Receiving (Secondary)
// ---------------------------------------------------------------------------

export interface SnapshotReceiver {
  /** Start receiving a new snapshot. */
  begin(totalFiles: number, totalBytes: number): void;
  /** Receive a chunk for a specific database file. */
  receiveChunk(fileName: string, chunkIndex: number, totalChunks: number, data: string): void;
  /** Finalize and verify the snapshot. Returns Result indicating success. */
  finalize(checksums: Record<string, string>): Result<void, EidolonError>;
  /** Whether receiving is currently in progress. */
  readonly inProgress: boolean;
}

/** Create a snapshot receiver that writes chunks to the given directory. */
export function createSnapshotReceiver(snapshotDir: string, logger: Logger): SnapshotReceiver {
  let receiving = false;
  const fileBuffers: Map<string, Buffer[]> = new Map();

  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true });
  }

  return {
    get inProgress(): boolean {
      return receiving;
    },

    begin(totalFiles: number, totalBytes: number): void {
      receiving = true;
      fileBuffers.clear();
      logger.info("snapshot", `Receiving snapshot: ${totalFiles} files, ${totalBytes} bytes`);
    },

    receiveChunk(fileName: string, chunkIndex: number, totalChunks: number, data: string): void {
      if (!receiving) return;

      let chunks = fileBuffers.get(fileName);
      if (!chunks) {
        chunks = new Array<Buffer>(totalChunks);
        fileBuffers.set(fileName, chunks);
      }
      chunks[chunkIndex] = Buffer.from(data, "base64");
    },

    finalize(checksums: Record<string, string>): Result<void, EidolonError> {
      if (!receiving) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, "No snapshot in progress"));
      }

      try {
        for (const [fileName, chunks] of fileBuffers) {
          // biome-ignore lint/complexity/useIndexOf: indexOf(undefined) rejected by TypeScript for Buffer[]
          const missing = chunks.findIndex((c) => c === undefined);
          if (missing >= 0) {
            return Err(createError(ErrorCode.DB_QUERY_FAILED, `Missing chunk ${missing} for ${fileName}`));
          }

          const fullData = Buffer.concat(chunks);
          const expectedChecksum = checksums[fileName];
          if (expectedChecksum) {
            const actualChecksum = createHash("sha256").update(fullData).digest("hex");
            if (actualChecksum !== expectedChecksum) {
              return Err(
                createError(
                  ErrorCode.DB_QUERY_FAILED,
                  `Checksum mismatch for ${fileName}: expected ${expectedChecksum}, got ${actualChecksum}`,
                ),
              );
            }
          }

          // Atomic write: temp file + rename
          const targetPath = join(snapshotDir, fileName);
          const tmpPath = `${targetPath}.tmp`;
          writeFileSync(tmpPath, fullData);
          renameSync(tmpPath, targetPath);
          logger.debug("snapshot", `Received ${fileName}: ${fullData.length} bytes`);
        }

        receiving = false;
        fileBuffers.clear();
        logger.info("snapshot", "Snapshot received and verified successfully");
        return Ok(undefined);
      } catch (cause) {
        receiving = false;
        fileBuffers.clear();
        return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to finalize snapshot", cause));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Remove snapshot files older than maxAgeMs from the snapshot directory. */
export function cleanupOldSnapshots(snapshotDir: string, maxAgeMs: number, logger: Logger): void {
  if (!existsSync(snapshotDir)) return;

  try {
    const files = readdirSync(snapshotDir);
    const now = Date.now();
    let removed = 0;

    for (const file of files) {
      const filePath = join(snapshotDir, file);

      if (file.endsWith(".tmp")) {
        unlinkSync(filePath);
        removed++;
        continue;
      }

      const stat = statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        unlinkSync(filePath);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug("snapshot", `Cleaned up ${removed} old snapshot files`);
    }
  } catch (err: unknown) {
    logger.warn("snapshot", "Failed to cleanup old snapshots", { error: String(err) });
  }
}
