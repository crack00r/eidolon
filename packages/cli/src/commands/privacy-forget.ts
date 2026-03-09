/**
 * PRIV-002: Comprehensive entity erasure (GDPR right to erasure).
 *
 * Cascading delete across all 3 databases:
 * - memory.db: memories, edges, KG entities/relations/communities
 * - operational.db: sessions, events, tasks, token usage, discoveries
 * - audit.db: PII redaction (legal requirement -- do NOT delete audit entries)
 * - Backup deletion (PRIV-003)
 */

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { BackupManager, createLogger, type DatabaseManager, getDataDir } from "@eidolon/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeletionReport {
  readonly entity: string;
  readonly timestamp: number;
  readonly deletedCounts: Record<string, number>;
  readonly totalDeleted: number;
  readonly backupsDeleted: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE metacharacters to prevent wildcard injection. */
function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

/** Safe table delete -- returns 0 if the table does not exist, re-throws other errors. */
function safeDelete(db: Database, sql: string, ...params: string[]): number {
  try {
    const result = db.query(sql).run(...params);
    return result.changes;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Only swallow "table not found" errors -- all other errors must propagate
    // so that the enclosing transaction rolls back for GDPR atomicity.
    if (message.includes("no such table")) {
      console.warn(`[privacy-forget] safeDelete skipped (table not found): ${message}`);
      return 0;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// forget command
// ---------------------------------------------------------------------------

export function forgetEntity(dbManager: DatabaseManager, entity: string): DeletionReport {
  if (!entity || entity.trim().length === 0) {
    throw new Error("Entity must not be empty or whitespace-only");
  }

  const deletedCounts: Record<string, number> = {};
  const escaped = escapeLikePattern(entity);
  const pattern = `%${escaped}%`;

  // --- memory.db: wrap all deletes in a single transaction ---
  const memoryTx = dbManager.memory.transaction(() => {
    deletedCounts.memory_edges = safeDelete(
      dbManager.memory,
      "DELETE FROM memory_edges WHERE source_id IN (SELECT id FROM memories WHERE content LIKE ? ESCAPE '\\') OR target_id IN (SELECT id FROM memories WHERE content LIKE ? ESCAPE '\\')",
      pattern,
      pattern,
    );

    deletedCounts.kg_complex_embeddings = safeDelete(
      dbManager.memory,
      "DELETE FROM kg_complex_embeddings WHERE entity_id IN (SELECT id FROM kg_entities WHERE name LIKE ? ESCAPE '\\')",
      pattern,
    );

    deletedCounts.kg_relations = safeDelete(
      dbManager.memory,
      "DELETE FROM kg_relations WHERE source_id IN (SELECT id FROM kg_entities WHERE name LIKE ? ESCAPE '\\') OR target_id IN (SELECT id FROM kg_entities WHERE name LIKE ? ESCAPE '\\')",
      pattern,
      pattern,
    );

    deletedCounts.kg_communities = safeDelete(
      dbManager.memory,
      "DELETE FROM kg_communities WHERE summary LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    deletedCounts.kg_entities = safeDelete(
      dbManager.memory,
      "DELETE FROM kg_entities WHERE name LIKE ? ESCAPE '\\'",
      pattern,
    );

    deletedCounts.memories = safeDelete(
      dbManager.memory,
      "DELETE FROM memories WHERE content LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
      pattern,
    );
  });
  memoryTx();

  // --- operational.db ---
  const operationalTx = dbManager.operational.transaction(() => {
    // token_usage must be deleted BEFORE sessions, because the subquery
    // references rows in sessions that will be removed below.
    deletedCounts.token_usage = safeDelete(
      dbManager.operational,
      "DELETE FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE metadata LIKE ? ESCAPE '\\')",
      pattern,
    );

    deletedCounts.sessions = safeDelete(
      dbManager.operational,
      "DELETE FROM sessions WHERE metadata LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    deletedCounts.events = safeDelete(
      dbManager.operational,
      "DELETE FROM events WHERE payload LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    deletedCounts.scheduled_tasks = safeDelete(
      dbManager.operational,
      "DELETE FROM scheduled_tasks WHERE payload LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    deletedCounts.discoveries = safeDelete(
      dbManager.operational,
      "DELETE FROM discoveries WHERE content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    deletedCounts.device_tokens = safeDelete(
      dbManager.operational,
      "DELETE FROM device_tokens WHERE token LIKE ? ESCAPE '\\'",
      pattern,
    );

    deletedCounts.user_consent = safeDelete(
      dbManager.operational,
      "DELETE FROM user_consent WHERE id LIKE ? ESCAPE '\\'",
      pattern,
    );

    deletedCounts.loop_state = safeDelete(
      dbManager.operational,
      "DELETE FROM loop_state WHERE value LIKE ? ESCAPE '\\'",
      pattern,
    );
  });
  operationalTx();

  // --- audit.db: KEEP entries (legal requirement) but REDACT PII fields ---
  // The audit_no_update trigger prevents UPDATE on audit_log, so we must
  // temporarily drop it, perform the redaction, then recreate it.
  const auditTx = dbManager.audit.transaction(() => {
    try {
      dbManager.audit.run("DROP TRIGGER IF EXISTS audit_no_update");

      const result = dbManager.audit
        .query(
          "UPDATE audit_log SET target = '[REDACTED]', metadata = '{}', integrity_hash = 'REDACTED:' || id WHERE target LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\'",
        )
        .run(pattern, pattern, pattern);
      deletedCounts.audit_log_redacted = result.changes;

      dbManager.audit.run(`
        CREATE TRIGGER IF NOT EXISTS audit_no_update
          BEFORE UPDATE ON audit_log
          BEGIN
            SELECT RAISE(ABORT, 'Audit log entries cannot be modified');
          END
      `);
    } catch (err: unknown) {
      console.error("[GDPR] Audit log PII redaction failed -- erasure incomplete:", err);
      try {
        dbManager.audit.run(`
          CREATE TRIGGER IF NOT EXISTS audit_no_update
            BEFORE UPDATE ON audit_log
            BEGIN
              SELECT RAISE(ABORT, 'Audit log entries cannot be modified');
            END
        `);
      } catch {
        /* trigger may already exist */
      }
      deletedCounts.audit_log_redacted = 0;
    }
  });
  auditTx();

  // --- VACUUM databases ---
  try {
    dbManager.memory.exec("VACUUM");
  } catch {
    /* Non-fatal */
  }
  try {
    dbManager.operational.exec("VACUUM");
  } catch {
    /* Non-fatal */
  }
  try {
    dbManager.audit.exec("VACUUM");
  } catch {
    /* Non-fatal */
  }

  // --- PRIV-003: Delete all backups ---
  let backupsDeleted = 0;
  try {
    const dbDir = getDataDir();
    const dbConfig = { directory: dbDir, walMode: true, backupSchedule: "0 3 * * *" };
    const loggingConfig = {
      level: "warn" as const,
      format: "pretty" as const,
      directory: "",
      maxSizeMb: 50,
      maxFiles: 10,
    };
    const logger = createLogger(loggingConfig);
    const backupMgr = new BackupManager(dbManager, dbConfig, logger);
    const deleteResult = backupMgr.deleteAllBackups();
    if (deleteResult.ok) {
      backupsDeleted = deleteResult.value;
    }
  } catch {
    // Best effort
  }

  // Log deletion to audit -- hash entity name to avoid storing PII after GDPR erasure
  const entityHash = createHash("sha256").update(entity).digest("hex");
  try {
    dbManager.audit
      .query(
        "INSERT INTO audit_log (id, timestamp, actor, action, target, result, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        Date.now(),
        "system",
        "privacy:forget",
        `sha256:${entityHash}`,
        "success",
        JSON.stringify({ deletedCounts, backupsDeleted }),
      );
  } catch {
    // Best effort
  }

  const totalDeleted = Object.values(deletedCounts).reduce((sum, n) => sum + n, 0);

  return { entity, timestamp: Date.now(), deletedCounts, totalDeleted, backupsDeleted };
}
