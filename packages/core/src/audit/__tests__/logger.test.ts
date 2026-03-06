/**
 * Tests for AuditLogger -- append-only audit trail with SHA-256 hash chaining.
 *
 * Uses real in-memory SQLite with the full audit schema (migrations applied).
 * No mocks for data -- only the Logger is a noop stub.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AuditEvent } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { AuditLogger } from "../logger.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Create an in-memory SQLite database with the full audit schema applied
 * (all three migrations: table, indexes, integrity_hash + triggers).
 */
function createAuditDb(): Database {
  const db = new Database(":memory:");

  // Migration 1: base table
  db.run(`
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('success','failure','denied')),
      metadata TEXT DEFAULT '{}'
    )
  `);
  db.run("CREATE INDEX idx_audit_timestamp ON audit_log(timestamp)");
  db.run("CREATE INDEX idx_audit_actor ON audit_log(actor)");
  db.run("CREATE INDEX idx_audit_action ON audit_log(action)");

  // Migration 2: extra indexes
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_result ON audit_log(result)");
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_actor_action ON audit_log(actor, action)");
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_timestamp_result ON audit_log(timestamp, result)");

  // Migration 3: integrity hash + append-only triggers
  db.run("ALTER TABLE audit_log ADD COLUMN integrity_hash TEXT NOT NULL DEFAULT ''");
  db.run("CREATE INDEX IF NOT EXISTS idx_audit_integrity ON audit_log(integrity_hash)");

  db.run(`
    CREATE TRIGGER IF NOT EXISTS audit_no_update
      BEFORE UPDATE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'Audit log entries cannot be modified');
      END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS audit_no_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'Audit log entries cannot be deleted');
      END
  `);

  return db;
}

function makeEvent(overrides?: Partial<AuditEvent>): AuditEvent {
  return {
    actor: "system",
    action: "test_action",
    target: "test_target",
    result: "success",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("AuditLogger", () => {
  let db: Database;
  let logger: AuditLogger;

  beforeEach(() => {
    db = createAuditDb();
    logger = new AuditLogger(db, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // log()
  // -----------------------------------------------------------------------

  describe("log()", () => {
    test("appends an audit entry and returns it", () => {
      const result = logger.log(makeEvent({ actor: "user:manuel", action: "shell_exec", target: "/bin/ls" }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const entry = result.value;
      expect(entry.id).toBeTruthy();
      expect(entry.actor).toBe("user:manuel");
      expect(entry.action).toBe("shell_exec");
      expect(entry.target).toBe("/bin/ls");
      expect(entry.result).toBe("success");
      expect(entry.integrityHash).toBeTruthy();
      expect(entry.integrityHash.length).toBe(64); // SHA-256 hex
      expect(entry.timestamp).toBeGreaterThan(0);
    });

    test("stores metadata (details) as JSON", () => {
      const details = { command: "ls -la", exitCode: 0, duration: 42 };
      const result = logger.log(makeEvent({ details }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.metadata).toEqual(details);

      // Verify it round-trips through the database
      const queryResult = logger.query({ limit: 1 });
      expect(queryResult.ok).toBe(true);
      if (!queryResult.ok) return;
      expect(queryResult.value[0]?.metadata).toEqual(details);
    });

    test("uses provided timestamp when given", () => {
      const fixedTs = 1700000000000;
      const result = logger.log(makeEvent({ timestamp: fixedTs }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.timestamp).toBe(fixedTs);
    });

    test("generates a timestamp when none is provided", () => {
      const before = Date.now();
      const result = logger.log(makeEvent());
      const after = Date.now();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.value.timestamp).toBeLessThanOrEqual(after);
    });

    test("handles empty details gracefully", () => {
      const result = logger.log(makeEvent({ details: undefined }));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.metadata).toEqual({});
    });

    test("each entry gets a unique id", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const result = logger.log(makeEvent());
        expect(result.ok).toBe(true);
        if (result.ok) ids.add(result.value.id);
      }
      expect(ids.size).toBe(20);
    });
  });

  // -----------------------------------------------------------------------
  // Hash chain integrity
  // -----------------------------------------------------------------------

  describe("hash chain", () => {
    test("first entry chains from the genesis hash", () => {
      const result = logger.log(makeEvent());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The hash should be deterministic given the same inputs
      expect(result.value.integrityHash).toHaveLength(64);
    });

    test("consecutive entries form a valid hash chain", () => {
      for (let i = 0; i < 5; i++) {
        const result = logger.log(makeEvent({ action: `action_${i}`, timestamp: 1000 + i }));
        expect(result.ok).toBe(true);
      }

      const verifyResult = logger.verifyIntegrity();
      expect(verifyResult.ok).toBe(true);
      if (!verifyResult.ok) return;
      expect(verifyResult.value).toBe(5);
    });

    test("detects tampered entries", () => {
      // Insert 3 valid entries
      for (let i = 0; i < 3; i++) {
        logger.log(makeEvent({ action: `step_${i}`, timestamp: 2000 + i }));
      }

      // Tamper with the second entry directly (bypass trigger by dropping it first)
      db.run("DROP TRIGGER IF EXISTS audit_no_update");
      db.run("UPDATE audit_log SET action = 'TAMPERED' WHERE rowid = 2");

      // Re-create the trigger
      db.run(`
        CREATE TRIGGER audit_no_update
          BEFORE UPDATE ON audit_log
          BEGIN SELECT RAISE(ABORT, 'Audit log entries cannot be modified'); END
      `);

      const verifyResult = logger.verifyIntegrity();
      expect(verifyResult.ok).toBe(false);
      if (verifyResult.ok) return;
      expect(verifyResult.error.message).toContain("integrity violation");
    });

    test("verifyIntegrity returns 0 for an empty log", () => {
      const result = logger.verifyIntegrity();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(0);
    });

    test("verifyIntegrity respects the limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        logger.log(makeEvent({ timestamp: 3000 + i }));
      }

      const result = logger.verifyIntegrity(5);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(5);
    });
  });

  // -----------------------------------------------------------------------
  // Append-only enforcement
  // -----------------------------------------------------------------------

  describe("append-only enforcement", () => {
    test("UPDATE is blocked by the trigger", () => {
      logger.log(makeEvent());

      expect(() => {
        db.run("UPDATE audit_log SET actor = 'hacker' WHERE rowid = 1");
      }).toThrow("Audit log entries cannot be modified");
    });

    test("DELETE is blocked by the trigger", () => {
      logger.log(makeEvent());

      expect(() => {
        db.run("DELETE FROM audit_log WHERE rowid = 1");
      }).toThrow("Audit log entries cannot be deleted");
    });
  });

  // -----------------------------------------------------------------------
  // query()
  // -----------------------------------------------------------------------

  describe("query()", () => {
    test("returns all entries when no filter is provided", () => {
      logger.log(makeEvent({ actor: "a1", timestamp: 1000 }));
      logger.log(makeEvent({ actor: "a2", timestamp: 2000 }));
      logger.log(makeEvent({ actor: "a3", timestamp: 3000 }));

      const result = logger.query();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(3);
      // Default order is timestamp DESC
      expect(result.value[0]?.actor).toBe("a3");
      expect(result.value[2]?.actor).toBe("a1");
    });

    test("filters by actor", () => {
      logger.log(makeEvent({ actor: "user:alice", timestamp: 1000 }));
      logger.log(makeEvent({ actor: "user:bob", timestamp: 2000 }));
      logger.log(makeEvent({ actor: "user:alice", timestamp: 3000 }));

      const result = logger.query({ actor: "user:alice" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value.every((e) => e.actor === "user:alice")).toBe(true);
    });

    test("filters by action", () => {
      logger.log(makeEvent({ action: "shell_exec", timestamp: 1000 }));
      logger.log(makeEvent({ action: "file_write", timestamp: 2000 }));
      logger.log(makeEvent({ action: "shell_exec", timestamp: 3000 }));

      const result = logger.query({ action: "file_write" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.action).toBe("file_write");
    });

    test("filters by target", () => {
      logger.log(makeEvent({ target: "/etc/passwd", timestamp: 1000 }));
      logger.log(makeEvent({ target: "/tmp/safe", timestamp: 2000 }));

      const result = logger.query({ target: "/etc/passwd" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.target).toBe("/etc/passwd");
    });

    test("filters by result", () => {
      logger.log(makeEvent({ result: "success", timestamp: 1000 }));
      logger.log(makeEvent({ result: "failure", timestamp: 2000 }));
      logger.log(makeEvent({ result: "denied", timestamp: 3000 }));
      logger.log(makeEvent({ result: "failure", timestamp: 4000 }));

      const result = logger.query({ result: "failure" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value.every((e) => e.result === "failure")).toBe(true);
    });

    test("filters by time range (startTime and endTime)", () => {
      logger.log(makeEvent({ timestamp: 1000 }));
      logger.log(makeEvent({ timestamp: 2000 }));
      logger.log(makeEvent({ timestamp: 3000 }));
      logger.log(makeEvent({ timestamp: 4000 }));

      const result = logger.query({ startTime: 2000, endTime: 3000 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value.every((e) => e.timestamp >= 2000 && e.timestamp <= 3000)).toBe(true);
    });

    test("combines multiple filters", () => {
      logger.log(makeEvent({ actor: "user:alice", action: "shell_exec", result: "success", timestamp: 1000 }));
      logger.log(makeEvent({ actor: "user:alice", action: "shell_exec", result: "denied", timestamp: 2000 }));
      logger.log(makeEvent({ actor: "user:bob", action: "shell_exec", result: "denied", timestamp: 3000 }));

      const result = logger.query({ actor: "user:alice", result: "denied" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.actor).toBe("user:alice");
      expect(result.value[0]?.result).toBe("denied");
    });

    test("respects the limit parameter", () => {
      for (let i = 0; i < 10; i++) {
        logger.log(makeEvent({ timestamp: 1000 + i }));
      }

      const result = logger.query({ limit: 3 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(3);
    });

    test("respects the offset parameter for pagination", () => {
      for (let i = 0; i < 5; i++) {
        logger.log(makeEvent({ actor: `user_${i}`, timestamp: 1000 + i }));
      }

      const page1 = logger.query({ limit: 2, offset: 0 });
      const page2 = logger.query({ limit: 2, offset: 2 });

      expect(page1.ok).toBe(true);
      expect(page2.ok).toBe(true);
      if (!page1.ok || !page2.ok) return;

      expect(page1.value).toHaveLength(2);
      expect(page2.value).toHaveLength(2);

      // No overlap between pages
      const page1Ids = page1.value.map((e) => e.id);
      const page2Ids = page2.value.map((e) => e.id);
      const overlap = page1Ids.filter((id) => page2Ids.includes(id));
      expect(overlap).toHaveLength(0);
    });

    test("clamps limit to MAX_QUERY_LIMIT (10000)", () => {
      // We don't insert 10001 entries -- just verify it doesn't throw
      // when we ask for an absurd limit
      const result = logger.query({ limit: 999999 });
      expect(result.ok).toBe(true);
    });

    test("returns empty array when no entries match", () => {
      logger.log(makeEvent({ actor: "alice" }));

      const result = logger.query({ actor: "bob" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });

    test("query results include integrityHash field", () => {
      logger.log(makeEvent());

      const result = logger.query();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value[0]?.integrityHash).toBeTruthy();
      expect(result.value[0]?.integrityHash).toHaveLength(64);
    });
  });

  // -----------------------------------------------------------------------
  // All three result types
  // -----------------------------------------------------------------------

  describe("result types", () => {
    test("stores and retrieves all three result types", () => {
      logger.log(makeEvent({ result: "success", timestamp: 1000 }));
      logger.log(makeEvent({ result: "failure", timestamp: 2000 }));
      logger.log(makeEvent({ result: "denied", timestamp: 3000 }));

      const all = logger.query({ limit: 10 });
      expect(all.ok).toBe(true);
      if (!all.ok) return;

      const results = all.value.map((e) => e.result).sort();
      expect(results).toEqual(["denied", "failure", "success"]);
    });
  });

  // -----------------------------------------------------------------------
  // Metadata edge cases
  // -----------------------------------------------------------------------

  describe("metadata handling", () => {
    test("handles deeply nested metadata", () => {
      const details = {
        command: { name: "deploy", args: ["--prod"] },
        env: { NODE_ENV: "production" },
        nested: { a: { b: { c: 42 } } },
      };
      const result = logger.log(makeEvent({ details }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const queried = logger.query({ limit: 1 });
      expect(queried.ok).toBe(true);
      if (!queried.ok) return;
      expect(queried.value[0]?.metadata).toEqual(details);
    });

    test("handles metadata with special characters", () => {
      const details = {
        message: 'O\'Brien said "hello" & <goodbye>',
        path: "/tmp/file with spaces/test.txt",
        unicode: "Hallo Welt \u{1F600}",
      };
      const result = logger.log(makeEvent({ details }));
      expect(result.ok).toBe(true);

      const queried = logger.query({ limit: 1 });
      expect(queried.ok).toBe(true);
      if (!queried.ok) return;
      expect(queried.value[0]?.metadata).toEqual(details);
    });
  });

  // -----------------------------------------------------------------------
  // Volume
  // -----------------------------------------------------------------------

  describe("volume", () => {
    test("handles 1000 entries with valid hash chain", () => {
      for (let i = 0; i < 1000; i++) {
        const result = logger.log(
          makeEvent({
            actor: `actor_${i % 10}`,
            action: `action_${i % 5}`,
            target: `target_${i}`,
            result: i % 3 === 0 ? "success" : i % 3 === 1 ? "failure" : "denied",
            timestamp: 100000 + i,
          }),
        );
        expect(result.ok).toBe(true);
      }

      // All entries present
      const all = logger.query({ limit: 10000 });
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      expect(all.value).toHaveLength(1000);

      // Hash chain is valid
      const integrity = logger.verifyIntegrity(10000);
      expect(integrity.ok).toBe(true);
      if (!integrity.ok) return;
      expect(integrity.value).toBe(1000);
    });

    test("query filters work efficiently on large datasets", () => {
      for (let i = 0; i < 200; i++) {
        logger.log(
          makeEvent({
            actor: i < 5 ? "rare_actor" : `common_${i}`,
            timestamp: 50000 + i,
          }),
        );
      }

      const result = logger.query({ actor: "rare_actor" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(5);
    });
  });

  // -----------------------------------------------------------------------
  // Required fields
  // -----------------------------------------------------------------------

  describe("required fields", () => {
    test("all required fields are persisted and retrievable", () => {
      const event: AuditEvent = {
        actor: "learning:session-42",
        action: "file_write",
        target: "/home/user/code.ts",
        result: "denied",
        details: { reason: "policy violation" },
        timestamp: 1700000000000,
      };

      const logResult = logger.log(event);
      expect(logResult.ok).toBe(true);
      if (!logResult.ok) return;

      const queryResult = logger.query({ limit: 1 });
      expect(queryResult.ok).toBe(true);
      if (!queryResult.ok) return;

      const entry = queryResult.value[0];
      if (!entry) return;
      expect(entry.id).toBeTruthy();
      expect(entry.timestamp).toBe(1700000000000);
      expect(entry.actor).toBe("learning:session-42");
      expect(entry.action).toBe("file_write");
      expect(entry.target).toBe("/home/user/code.ts");
      expect(entry.result).toBe("denied");
      expect(entry.integrityHash).toHaveLength(64);
      expect(entry.metadata).toEqual({ reason: "policy violation" });
    });
  });

  // -----------------------------------------------------------------------
  // Default ordering
  // -----------------------------------------------------------------------

  describe("ordering", () => {
    test("query returns entries in descending timestamp order", () => {
      logger.log(makeEvent({ timestamp: 1000 }));
      logger.log(makeEvent({ timestamp: 3000 }));
      logger.log(makeEvent({ timestamp: 2000 }));

      const result = logger.query();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value[0]?.timestamp).toBe(3000);
      expect(result.value[1]?.timestamp).toBe(2000);
      expect(result.value[2]?.timestamp).toBe(1000);
    });
  });
});
