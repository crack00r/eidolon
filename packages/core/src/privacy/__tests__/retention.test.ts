import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PrivacyConfig } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { RetentionEnforcer } from "../retention.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function createOperationalDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('main','task','learning','dream','voice','review')),
      status TEXT NOT NULL CHECK(status IN ('running','paused','completed','failed')),
      claude_session_id TEXT,
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      completed_at INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}'
    );

    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      priority TEXT NOT NULL CHECK(priority IN ('critical','high','normal','low')),
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      processed_at INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      session_type TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );

    CREATE TABLE discoveries (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      relevance_score REAL NOT NULL,
      safety_level TEXT NOT NULL CHECK(safety_level IN ('safe','needs_approval','dangerous')),
      status TEXT NOT NULL CHECK(status IN ('new','evaluated','approved','rejected','implemented')),
      implementation_branch TEXT,
      created_at INTEGER NOT NULL,
      evaluated_at INTEGER,
      implemented_at INTEGER
    );
  `);
  return db;
}

function createAuditDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('success','failure','denied')),
      metadata TEXT DEFAULT '{}'
    );
  `);
  return db;
}

/** Insert a session into the operational DB. */
function insertSession(db: Database, id: string, status: string, startedAt: number): void {
  db.query("INSERT INTO sessions (id, type, status, started_at, last_activity_at) VALUES (?, 'task', ?, ?, ?)").run(
    id,
    status,
    startedAt,
    startedAt,
  );
}

/** Insert a processed event into the operational DB. */
function insertEvent(db: Database, id: string, timestamp: number, processedAt: number | null): void {
  db.query(
    "INSERT INTO events (id, type, priority, payload, source, timestamp, processed_at) VALUES (?, 'user:message', 'normal', '{}', 'test', ?, ?)",
  ).run(id, timestamp, processedAt);
}

/** Insert a token usage record. */
function insertTokenUsage(db: Database, sessionId: string, timestamp: number): void {
  db.query(
    "INSERT INTO token_usage (session_id, session_type, model, input_tokens, output_tokens, cost_usd, timestamp) VALUES (?, 'task', 'claude-sonnet', 100, 50, 0.01, ?)",
  ).run(sessionId, timestamp);
}

/** Insert a discovery record. */
function insertDiscovery(db: Database, id: string, status: string, createdAt: number): void {
  db.query(
    "INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at) VALUES (?, 'reddit', ?, 'test', 'content', 0.8, 'safe', ?, ?)",
  ).run(id, `https://example.com/${id}`, status, createdAt);
}

/** Insert an audit log entry. */
function insertAuditEntry(db: Database, id: string, timestamp: number): void {
  db.query(
    "INSERT INTO audit_log (id, timestamp, actor, action, target, result) VALUES (?, ?, 'system', 'test_action', 'test_target', 'success')",
  ).run(id, timestamp);
}

/** Count rows in a table. */
function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RetentionEnforcer", () => {
  let operational: Database;
  let audit: Database;
  const logger = createSilentLogger();

  beforeEach(() => {
    operational = createOperationalDb();
    audit = createAuditDb();
  });

  afterEach(() => {
    operational.close();
    audit.close();
  });

  // -----------------------------------------------------------------------
  // Default config
  // -----------------------------------------------------------------------

  test("uses default retention periods when no privacy config provided", () => {
    const enforcer = new RetentionEnforcer(operational, audit, undefined, logger);
    const result = enforcer.enforce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // No data to delete, all counts should be 0
      expect(result.value.totalDeleted).toBe(0);
      expect(result.value.errors).toHaveLength(0);
    }
  });

  // -----------------------------------------------------------------------
  // Sessions retention
  // -----------------------------------------------------------------------

  test("deletes completed/failed sessions older than conversationsDays", () => {
    const now = Date.now();
    const old = now - 100 * MS_PER_DAY;
    const recent = now - 10 * MS_PER_DAY;

    // Old completed session -- should be deleted (with retention 30 days)
    insertSession(operational, "old-completed", "completed", old);
    // Old failed session -- should be deleted
    insertSession(operational, "old-failed", "failed", old);
    // Recent completed session -- should be kept
    insertSession(operational, "recent-completed", "completed", recent);
    // Old running session -- should NOT be deleted (not completed/failed)
    insertSession(operational, "old-running", "running", old);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 30, eventsDays: 90, tokenUsageDays: 180, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCounts.sessions).toBe(2);
    }

    // Verify data is actually gone
    expect(count(operational, "sessions")).toBe(2); // recent-completed + old-running
  });

  test("preserves running and paused sessions regardless of age", () => {
    const old = Date.now() - 500 * MS_PER_DAY;
    insertSession(operational, "running-1", "running", old);
    insertSession(operational, "paused-1", "paused", old);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 1, eventsDays: 90, tokenUsageDays: 180, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    enforcer.enforce();

    expect(count(operational, "sessions")).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Events retention
  // -----------------------------------------------------------------------

  test("deletes processed events older than eventsDays", () => {
    const now = Date.now();
    const old = now - 100 * MS_PER_DAY;
    const recent = now - 5 * MS_PER_DAY;

    // Old processed event -- should be deleted
    insertEvent(operational, "old-processed", old, old + 1000);
    // Old unprocessed event -- should NOT be deleted
    insertEvent(operational, "old-unprocessed", old, null);
    // Recent processed event -- should be kept
    insertEvent(operational, "recent-processed", recent, recent + 1000);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 365, eventsDays: 30, tokenUsageDays: 180, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCounts.events).toBe(1);
    }
    expect(count(operational, "events")).toBe(2); // old-unprocessed + recent-processed
  });

  test("preserves unprocessed events regardless of age", () => {
    const veryOld = Date.now() - 1000 * MS_PER_DAY;
    insertEvent(operational, "unprocessed-1", veryOld, null);
    insertEvent(operational, "unprocessed-2", veryOld, null);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 365, eventsDays: 1, tokenUsageDays: 180, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    enforcer.enforce();

    expect(count(operational, "events")).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Token usage retention
  // -----------------------------------------------------------------------

  test("deletes token usage records older than tokenUsageDays", () => {
    const now = Date.now();
    const old = now - 200 * MS_PER_DAY;
    const recent = now - 10 * MS_PER_DAY;

    insertTokenUsage(operational, "sess-old", old);
    insertTokenUsage(operational, "sess-recent", recent);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 365, eventsDays: 90, tokenUsageDays: 60, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCounts.token_usage).toBe(1);
    }
    expect(count(operational, "token_usage")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Discoveries retention
  // -----------------------------------------------------------------------

  test("deletes rejected/implemented discoveries older than conversationsDays", () => {
    const now = Date.now();
    const old = now - 400 * MS_PER_DAY;
    const recent = now - 10 * MS_PER_DAY;

    // Old rejected -- should be deleted
    insertDiscovery(operational, "disc-rejected", "rejected", old);
    // Old implemented -- should be deleted
    insertDiscovery(operational, "disc-implemented", "implemented", old);
    // Old new -- should NOT be deleted (status not rejected/implemented)
    insertDiscovery(operational, "disc-new", "new", old);
    // Old approved -- should NOT be deleted
    insertDiscovery(operational, "disc-approved", "approved", old);
    // Recent rejected -- should be kept
    insertDiscovery(operational, "disc-recent-rejected", "rejected", recent);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 30, eventsDays: 90, tokenUsageDays: 180, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCounts.discoveries).toBe(2);
    }
    expect(count(operational, "discoveries")).toBe(3); // new + approved + recent-rejected
  });

  // -----------------------------------------------------------------------
  // Audit log retention
  // -----------------------------------------------------------------------

  test("never deletes audit logs when auditLogDays is -1", () => {
    const veryOld = Date.now() - 3650 * MS_PER_DAY; // 10 years ago
    insertAuditEntry(audit, "audit-1", veryOld);
    insertAuditEntry(audit, "audit-2", veryOld);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 365, eventsDays: 90, tokenUsageDays: 180, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCounts.audit_log).toBe(0);
    }
    expect(count(audit, "audit_log")).toBe(2);
  });

  test("deletes audit logs when auditLogDays is explicitly set to a positive value", () => {
    const now = Date.now();
    const old = now - 400 * MS_PER_DAY;
    const recent = now - 10 * MS_PER_DAY;

    insertAuditEntry(audit, "audit-old", old);
    insertAuditEntry(audit, "audit-recent", recent);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 365, eventsDays: 90, tokenUsageDays: 180, auditLogDays: 30 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCounts.audit_log).toBe(1);
    }
    expect(count(audit, "audit_log")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // No matching data
  // -----------------------------------------------------------------------

  test("handles empty tables gracefully", () => {
    const config: PrivacyConfig = {
      retention: { conversationsDays: 1, eventsDays: 1, tokenUsageDays: 1, auditLogDays: 1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalDeleted).toBe(0);
      expect(result.value.deletedCounts.sessions).toBe(0);
      expect(result.value.deletedCounts.events).toBe(0);
      expect(result.value.deletedCounts.token_usage).toBe(0);
      expect(result.value.deletedCounts.discoveries).toBe(0);
      expect(result.value.deletedCounts.audit_log).toBe(0);
      expect(result.value.errors).toHaveLength(0);
    }
  });

  test("does nothing when all data is within retention period", () => {
    const recent = Date.now() - 5 * MS_PER_DAY;

    insertSession(operational, "s1", "completed", recent);
    insertEvent(operational, "e1", recent, recent + 1000);
    insertTokenUsage(operational, "sess-1", recent);
    insertDiscovery(operational, "d1", "rejected", recent);
    insertAuditEntry(audit, "a1", recent);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 365, eventsDays: 90, tokenUsageDays: 180, auditLogDays: 30 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalDeleted).toBe(0);
    }
    // All data still present
    expect(count(operational, "sessions")).toBe(1);
    expect(count(operational, "events")).toBe(1);
    expect(count(operational, "token_usage")).toBe(1);
    expect(count(operational, "discoveries")).toBe(1);
    expect(count(audit, "audit_log")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Comprehensive enforcement across all tables
  // -----------------------------------------------------------------------

  test("enforces retention across all tables in a single call", () => {
    const now = Date.now();
    const old = now - 200 * MS_PER_DAY;
    const recent = now - 5 * MS_PER_DAY;

    // Seed old data in every table
    insertSession(operational, "s-old", "completed", old);
    insertSession(operational, "s-recent", "completed", recent);
    insertEvent(operational, "e-old", old, old + 100);
    insertEvent(operational, "e-recent", recent, recent + 100);
    insertTokenUsage(operational, "t-old", old);
    insertTokenUsage(operational, "t-recent", recent);
    insertDiscovery(operational, "d-old", "rejected", old);
    insertDiscovery(operational, "d-recent", "implemented", recent);
    insertAuditEntry(audit, "a-old", old);
    insertAuditEntry(audit, "a-recent", recent);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 30, eventsDays: 30, tokenUsageDays: 30, auditLogDays: 30 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deletedCounts.sessions).toBe(1);
      expect(result.value.deletedCounts.events).toBe(1);
      expect(result.value.deletedCounts.token_usage).toBe(1);
      expect(result.value.deletedCounts.discoveries).toBe(1);
      expect(result.value.deletedCounts.audit_log).toBe(1);
      expect(result.value.totalDeleted).toBe(5);
    }

    // Verify only recent data remains
    expect(count(operational, "sessions")).toBe(1);
    expect(count(operational, "events")).toBe(1);
    expect(count(operational, "token_usage")).toBe(1);
    expect(count(operational, "discoveries")).toBe(1);
    expect(count(audit, "audit_log")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Report structure
  // -----------------------------------------------------------------------

  test("returns a well-formed RetentionReport with timestamp", () => {
    const before = Date.now();
    const enforcer = new RetentionEnforcer(operational, audit, undefined, logger);
    const result = enforcer.enforce();
    const after = Date.now();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.value.timestamp).toBeLessThanOrEqual(after);
      expect(typeof result.value.totalDeleted).toBe("number");
      expect(Array.isArray(result.value.errors)).toBe(true);
      expect(result.value.deletedCounts).toHaveProperty("sessions");
      expect(result.value.deletedCounts).toHaveProperty("events");
      expect(result.value.deletedCounts).toHaveProperty("token_usage");
      expect(result.value.deletedCounts).toHaveProperty("discoveries");
      expect(result.value.deletedCounts).toHaveProperty("audit_log");
    }
  });

  // -----------------------------------------------------------------------
  // Error handling: missing tables produce errors, not crashes
  // -----------------------------------------------------------------------

  test("returns Err with error details when a table is missing", () => {
    // Create a DB with no tables to trigger SQL errors
    const brokenOperational = new Database(":memory:");
    const brokenAudit = new Database(":memory:");

    const enforcer = new RetentionEnforcer(brokenOperational, brokenAudit, undefined, logger);
    const result = enforcer.enforce();

    // The enforcer should still return (not throw), but report errors
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("error(s)");
    }

    brokenOperational.close();
    brokenAudit.close();
  });

  // -----------------------------------------------------------------------
  // Boundary: exact cutoff timestamp
  // -----------------------------------------------------------------------

  test("handles boundary timestamps correctly (exactly at cutoff)", () => {
    const now = Date.now();
    const exactCutoff = now - 30 * MS_PER_DAY;

    // Session at exactly the cutoff -- started_at < cutoff is false, so preserved
    insertSession(operational, "s-boundary", "completed", exactCutoff);
    // Session 1ms before cutoff -- should be deleted
    insertSession(operational, "s-just-before", "completed", exactCutoff - 1);
    // Session 1ms after cutoff -- should be preserved
    insertSession(operational, "s-just-after", "completed", exactCutoff + 1);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 30, eventsDays: 90, tokenUsageDays: 180, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the "just-before" session should be deleted
      expect(result.value.deletedCounts.sessions).toBe(1);
    }
    expect(count(operational, "sessions")).toBe(2); // boundary + just-after
  });

  // -----------------------------------------------------------------------
  // Multiple enforcements are idempotent
  // -----------------------------------------------------------------------

  test("running enforce multiple times is idempotent", () => {
    const old = Date.now() - 200 * MS_PER_DAY;
    insertSession(operational, "s1", "completed", old);
    insertTokenUsage(operational, "t1", old);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 30, eventsDays: 30, tokenUsageDays: 30, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);

    // First run should delete
    const first = enforcer.enforce();
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.value.totalDeleted).toBe(2);
    }

    // Second run should find nothing more to delete
    const second = enforcer.enforce();
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.totalDeleted).toBe(0);
    }

    expect(count(operational, "sessions")).toBe(0);
    expect(count(operational, "token_usage")).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Large retention period (effectively never delete)
  // -----------------------------------------------------------------------

  test("very large retention period preserves all data", () => {
    const old = Date.now() - 3000 * MS_PER_DAY; // ~8 years ago
    insertSession(operational, "s1", "completed", old);
    insertEvent(operational, "e1", old, old + 100);
    insertTokenUsage(operational, "t1", old);
    insertDiscovery(operational, "d1", "rejected", old);

    const config: PrivacyConfig = {
      retention: {
        conversationsDays: 36500, // 100 years
        eventsDays: 36500,
        tokenUsageDays: 36500,
        auditLogDays: -1,
      },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(operational, audit, config, logger);
    const result = enforcer.enforce();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.totalDeleted).toBe(0);
    }
    expect(count(operational, "sessions")).toBe(1);
    expect(count(operational, "events")).toBe(1);
    expect(count(operational, "token_usage")).toBe(1);
    expect(count(operational, "discoveries")).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Partial failure: one table fails but others succeed
  // -----------------------------------------------------------------------

  test("continues enforcement even when one table fails", () => {
    const now = Date.now();
    const old = now - 200 * MS_PER_DAY;

    // Create an operational DB with only some tables
    const partialDb = new Database(":memory:");
    partialDb.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        last_activity_at INTEGER NOT NULL
      );
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_type TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
    // events and discoveries tables are missing -- will cause errors

    insertSession(partialDb, "s1", "completed", old);
    insertTokenUsage(partialDb, "t1", old);

    const config: PrivacyConfig = {
      retention: { conversationsDays: 30, eventsDays: 30, tokenUsageDays: 30, auditLogDays: -1 },
      encryptBackups: true,
    };
    const enforcer = new RetentionEnforcer(partialDb, audit, config, logger);
    const result = enforcer.enforce();

    // Should return Err because of partial failures
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("error(s)");
    }

    // But the successful tables should still have been cleaned
    expect(count(partialDb, "sessions")).toBe(0);
    expect(count(partialDb, "token_usage")).toBe(0);

    partialDb.close();
  });
});
