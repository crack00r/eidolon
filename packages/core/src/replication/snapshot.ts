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
  appendFileSync,
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
import { join, resolve, sep } from "node:path";
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

/**
 * Characters forbidden in snapshot paths to prevent SQL injection via VACUUM INTO.
 * Matches the pattern used in backup/manager.ts.
 */
const FORBIDDEN_PATH_CHARS = /['\0\\;]/;

/**
 * Validate that a resolved path stays within the expected directory.
 * Prevents path traversal attacks from peer-supplied file names.
 */
function validateSnapshotPath(fileName: string, baseDir: string): Result<string, EidolonError> {
  const resolved = resolve(baseDir, fileName);
  const canonicalBase = resolve(baseDir);
  if (!resolved.startsWith(canonicalBase + sep)) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Snapshot path traversal rejected: ${fileName}`));
  }
  if (FORBIDDEN_PATH_CHARS.test(resolved)) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Snapshot path contains forbidden characters: ${fileName}`));
  }
  return Ok(resolved);
}

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
      const pathResult = validateSnapshotPath(`${timestamp}_${fileName}`, snapshotDir);
      if (!pathResult.ok) return Err(pathResult.error);
      const snapshotPath = pathResult.value;

      // VACUUM INTO requires a literal path in SQL. validateSnapshotPath()
      // rejects ' \ ; NUL via FORBIDDEN_PATH_CHARS, making injection impossible.
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

/** Tracking state for each file being received. */
interface FileReceiveState {
  readonly tmpPath: string;
  readonly totalChunks: number;
  receivedCount: number;
  readonly received: Set<number>;
  /** Buffered chunks keyed by index -- written in order during finalize. */
  readonly chunks: Map<number, Buffer>;
}

/** Create a snapshot receiver that writes chunks directly to disk. */
export function createSnapshotReceiver(snapshotDir: string, logger: Logger): SnapshotReceiver {
  let receiving = false;
  const fileStates: Map<string, FileReceiveState> = new Map();

  if (!existsSync(snapshotDir)) {
    mkdirSync(snapshotDir, { recursive: true });
  }

  return {
    get inProgress(): boolean {
      return receiving;
    },

    begin(totalFiles: number, totalBytes: number): void {
      receiving = true;
      fileStates.clear();
      logger.info("snapshot", `Receiving snapshot: ${totalFiles} files, ${totalBytes} bytes`);
    },

    receiveChunk(fileName: string, chunkIndex: number, totalChunks: number, data: string): void {
      if (!receiving) return;

      // Validate fileName against path traversal
      const pathResult = validateSnapshotPath(fileName, snapshotDir);
      if (!pathResult.ok) {
        logger.warn("snapshot", `Rejected chunk with invalid fileName: ${fileName}`);
        return;
      }

      let state = fileStates.get(fileName);
      if (!state) {
        const tmpPath = `${pathResult.value}.incoming`;
        state = { tmpPath, totalChunks, receivedCount: 0, received: new Set(), chunks: new Map() };
        fileStates.set(fileName, state);
      }

      if (!state.received.has(chunkIndex)) {
        // Buffer chunks in memory keyed by index -- they are written
        // in order during finalize() to avoid corruption from
        // out-of-order delivery.
        state.chunks.set(chunkIndex, Buffer.from(data, "base64"));
        state.received.add(chunkIndex);
        state.receivedCount++;
      }
    },

    finalize(checksums: Record<string, string>): Result<void, EidolonError> {
      if (!receiving) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, "No snapshot in progress"));
      }

      try {
        for (const [fileName, state] of fileStates) {
          if (state.receivedCount < state.totalChunks) {
            cleanupIncomingFiles(fileStates);
            receiving = false;
            fileStates.clear();
            return Err(
              createError(
                ErrorCode.DB_QUERY_FAILED,
                `Missing chunks for ${fileName}: got ${state.receivedCount}/${state.totalChunks}`,
              ),
            );
          }

          // Write chunks in order to the temp file to prevent corruption
          // from out-of-order chunk delivery.
          writeFileSync(state.tmpPath, Buffer.alloc(0));
          for (let i = 0; i < state.totalChunks; i++) {
            const chunk = state.chunks.get(i);
            if (!chunk) {
              cleanupIncomingFiles(fileStates);
              receiving = false;
              fileStates.clear();
              return Err(createError(ErrorCode.DB_QUERY_FAILED, `Missing chunk ${i} for ${fileName}`));
            }
            appendFileSync(state.tmpPath, chunk);
          }

          const expectedChecksum = checksums[fileName];
          if (!expectedChecksum) {
            cleanupIncomingFiles(fileStates);
            receiving = false;
            fileStates.clear();
            return Err(
              createError(ErrorCode.DB_QUERY_FAILED, `Missing checksum for ${fileName} -- cannot verify integrity`),
            );
          }

          const fileData = readFileSync(state.tmpPath);
          const actualChecksum = createHash("sha256").update(fileData).digest("hex");
          if (actualChecksum !== expectedChecksum) {
            cleanupIncomingFiles(fileStates);
            receiving = false;
            fileStates.clear();
            return Err(
              createError(
                ErrorCode.DB_QUERY_FAILED,
                `Checksum mismatch for ${fileName}: expected ${expectedChecksum}, got ${actualChecksum}`,
              ),
            );
          }

          // Atomic rename to final path
          const pathResult = validateSnapshotPath(fileName, snapshotDir);
          if (!pathResult.ok) {
            cleanupIncomingFiles(fileStates);
            receiving = false;
            fileStates.clear();
            return Err(pathResult.error);
          }

          renameSync(state.tmpPath, pathResult.value);
          const size = statSync(pathResult.value).size;
          logger.debug("snapshot", `Received ${fileName}: ${size} bytes`);
        }

        receiving = false;
        fileStates.clear();
        logger.info("snapshot", "Snapshot received and verified successfully");
        return Ok(undefined);
      } catch (cause) {
        cleanupIncomingFiles(fileStates);
        receiving = false;
        fileStates.clear();
        return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to finalize snapshot", cause));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Incoming file cleanup helper
// ---------------------------------------------------------------------------

/** Remove all .incoming temp files tracked by the file states map. */
function cleanupIncomingFiles(states: ReadonlyMap<string, FileReceiveState>): void {
  for (const [, state] of states) {
    try {
      if (existsSync(state.tmpPath)) {
        unlinkSync(state.tmpPath);
      }
    } catch {
      // Best-effort cleanup -- ignore errors
    }
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Minimum age (1 hour) before .incoming files are eligible for cleanup. */
const INCOMING_MIN_AGE_MS = 60 * 60 * 1000;

/** Remove snapshot files older than maxAgeMs from the snapshot directory. */
export function cleanupOldSnapshots(snapshotDir: string, maxAgeMs: number, logger: Logger): void {
  if (!existsSync(snapshotDir)) return;

  const canonicalBase = resolve(snapshotDir);

  try {
    const files = readdirSync(snapshotDir);
    const now = Date.now();
    let removed = 0;

    for (const file of files) {
      const filePath = resolve(snapshotDir, file);

      // Path traversal guard: ensure resolved path is inside snapshotDir
      if (!filePath.startsWith(canonicalBase + sep)) {
        logger.warn("snapshot", `Skipping file outside snapshot directory: ${file}`);
        continue;
      }

      const stat = statSync(filePath);

      if (file.endsWith(".tmp") || file.endsWith(".incoming")) {
        // Only delete .tmp/.incoming files older than 1 hour to avoid
        // removing files from an in-progress transfer.
        if (now - stat.mtimeMs > INCOMING_MIN_AGE_MS) {
          unlinkSync(filePath);
          removed++;
        }
        continue;
      }

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
