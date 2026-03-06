/**
 * AuditLogger -- append-only audit log writer and reader.
 *
 * Writes to the audit_log table in audit.db with SHA-256 hash chaining
 * for tamper detection. Each entry's integrity_hash is computed from
 * the previous entry's hash plus the current entry data.
 */

import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { AuditEntry, AuditEvent, AuditFilter, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface AuditRow {
  readonly id: string;
  readonly timestamp: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly result: string;
  readonly metadata: string;
  readonly integrity_hash: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Initial hash used as the "previous hash" for the very first audit entry. */
const GENESIS_HASH = "0000000000000000000000000000000000000000000000000000000000000000";

/** Maximum number of audit entries returned by a single query. */
const MAX_QUERY_LIMIT = 10_000;

/** Default query limit. */
const DEFAULT_QUERY_LIMIT = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeIntegrityHash(
  previousHash: string,
  entry: {
    readonly id: string;
    readonly timestamp: number;
    readonly actor: string;
    readonly action: string;
    readonly target: string;
    readonly result: string;
    readonly metadata: string;
  },
): string {
  const data = `${previousHash}|${entry.id}|${entry.timestamp}|${entry.actor}|${entry.action}|${entry.target}|${entry.result}|${entry.metadata}`;
  return createHash("sha256").update(data).digest("hex");
}

function rowToAuditEntry(row: AuditRow): AuditEntry {
  let metadata: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.metadata ?? "{}");
    metadata =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    // Intentional: malformed JSON metadata defaults to empty object
    metadata = {};
  }

  return {
    id: row.id,
    timestamp: row.timestamp,
    actor: row.actor,
    action: row.action,
    target: row.target,
    result: row.result as AuditEntry["result"],
    integrityHash: row.integrity_hash,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

export class AuditLogger {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("audit");
  }

  /** Append an audit event to the log with hash chaining. */
  log(event: AuditEvent): Result<AuditEntry, EidolonError> {
    try {
      const id = randomUUID();
      const timestamp = event.timestamp ?? Date.now();
      const metadata = JSON.stringify(event.details ?? {});

      // Get the last integrity hash for chain continuity
      const lastRow = this.db.query("SELECT integrity_hash FROM audit_log ORDER BY rowid DESC LIMIT 1").get() as {
        integrity_hash: string;
      } | null;

      const previousHash = lastRow?.integrity_hash ?? GENESIS_HASH;

      const integrityHash = computeIntegrityHash(previousHash, {
        id,
        timestamp,
        actor: event.actor,
        action: event.action,
        target: event.target,
        result: event.result,
        metadata,
      });

      this.db
        .query(
          `INSERT INTO audit_log (id, timestamp, actor, action, target, result, metadata, integrity_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, timestamp, event.actor, event.action, event.target, event.result, metadata, integrityHash);

      const entry: AuditEntry = {
        id,
        timestamp,
        actor: event.actor,
        action: event.action,
        target: event.target,
        result: event.result,
        integrityHash,
        metadata: event.details ?? {},
      };

      this.logger.debug("log", `Audit entry: ${event.actor} ${event.action} ${event.target}`, {
        auditId: id,
        result: event.result,
      });

      return Ok(entry);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to write audit log entry", cause));
    }
  }

  /** Query audit entries with optional filtering. */
  query(filter?: AuditFilter): Result<AuditEntry[], EidolonError> {
    try {
      const whereClauses: string[] = [];
      const params: Array<string | number> = [];

      if (filter?.actor) {
        whereClauses.push("actor = ?");
        params.push(filter.actor);
      }
      if (filter?.action) {
        whereClauses.push("action = ?");
        params.push(filter.action);
      }
      if (filter?.target) {
        whereClauses.push("target = ?");
        params.push(filter.target);
      }
      if (filter?.result) {
        whereClauses.push("result = ?");
        params.push(filter.result);
      }
      if (filter?.startTime !== undefined) {
        whereClauses.push("timestamp >= ?");
        params.push(filter.startTime);
      }
      if (filter?.endTime !== undefined) {
        whereClauses.push("timestamp <= ?");
        params.push(filter.endTime);
      }

      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
      const limit = Math.max(1, Math.min(filter?.limit ?? DEFAULT_QUERY_LIMIT, MAX_QUERY_LIMIT));
      const offset = Math.max(0, filter?.offset ?? 0);

      const sql = `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = this.db.query(sql).all(...params) as AuditRow[];
      return Ok(rows.map(rowToAuditEntry));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to query audit log", cause));
    }
  }

  /**
   * Verify the integrity of the hash chain.
   * Returns the number of entries verified, or an error if tampering is detected.
   */
  verifyIntegrity(limit?: number): Result<number, EidolonError> {
    try {
      const maxEntries = Math.max(1, Math.min(limit ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT));
      const rows = this.db.query("SELECT * FROM audit_log ORDER BY rowid ASC LIMIT ?").all(maxEntries) as AuditRow[];

      let previousHash = GENESIS_HASH;

      for (const row of rows) {
        const expectedHash = computeIntegrityHash(previousHash, {
          id: row.id,
          timestamp: row.timestamp,
          actor: row.actor,
          action: row.action,
          target: row.target,
          result: row.result,
          metadata: row.metadata,
        });

        if (row.integrity_hash !== expectedHash) {
          return Err(
            createError(
              ErrorCode.DB_QUERY_FAILED,
              `Audit log integrity violation at entry ${row.id}: expected hash ${expectedHash}, got ${row.integrity_hash}`,
            ),
          );
        }

        previousHash = row.integrity_hash;
      }

      this.logger.info("verify", `Audit log integrity verified for ${rows.length} entries`);
      return Ok(rows.length);
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && "code" in cause) {
        return Err(cause as EidolonError);
      }
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to verify audit log integrity", cause));
    }
  }
}
