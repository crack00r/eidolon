/**
 * Tests for GDPR audit log erasure utility.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gdprEraseAuditRecords } from "../gdpr-audit-erasure.ts";

// ---------------------------------------------------------------------------
// Schema setup -- mirrors audit.ts migrations v1 + v3
// ---------------------------------------------------------------------------

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
      metadata TEXT DEFAULT '{}',
      integrity_hash TEXT NOT NULL DEFAULT ''
    );

    CREATE TRIGGER audit_no_delete
      BEFORE DELETE ON audit_log
      BEGIN
        SELECT RAISE(ABORT, 'Audit log entries cannot be deleted');
      END;
  `);
  return db;
}

const now = Date.now();

function insertEntry(db: Database, id: string, target: string): void {
  db.query(
    "INSERT INTO audit_log (id, timestamp, actor, action, target, result) VALUES (?, ?, 'system', 'test', ?, 'success')",
  ).run(id, now, target);
}

function count(db: Database): number {
  return (db.query("SELECT COUNT(*) as c FROM audit_log").get() as { c: number }).c;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gdprEraseAuditRecords", () => {
  let db: Database;

  beforeEach(() => {
    db = createAuditDb();
  });

  afterEach(() => {
    db.close();
  });

  test("normal DELETE is blocked by trigger", () => {
    insertEntry(db, "a1", "user:Manuel");

    expect(() => {
      db.query("DELETE FROM audit_log WHERE id = ?").run("a1");
    }).toThrow("Audit log entries cannot be deleted");

    expect(count(db)).toBe(1);
  });

  test("gdprEraseAuditRecords deletes matching records", () => {
    insertEntry(db, "a1", "user:Manuel");
    insertEntry(db, "a2", "user:Anna");
    insertEntry(db, "a3", "user:Manuel");

    const result = gdprEraseAuditRecords(db, "target = ?", ["user:Manuel"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(2);
    expect(count(db)).toBe(1);
  });

  test("trigger is restored after erasure", () => {
    insertEntry(db, "a1", "user:Manuel");
    insertEntry(db, "a2", "user:Anna");

    gdprEraseAuditRecords(db, "target = ?", ["user:Manuel"]);

    // Normal DELETE should still be blocked after the GDPR erasure
    expect(() => {
      db.query("DELETE FROM audit_log WHERE id = ?").run("a2");
    }).toThrow("Audit log entries cannot be deleted");

    expect(count(db)).toBe(1);
  });

  test("returns 0 when no records match", () => {
    insertEntry(db, "a1", "user:Anna");

    const result = gdprEraseAuditRecords(db, "target = ?", ["user:Manuel"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(0);
    expect(count(db)).toBe(1);
  });

  test("rejects empty filter", () => {
    const result = gdprEraseAuditRecords(db, "  ", []);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("INVALID_INPUT");
  });

  test("supports LIKE filter with wildcard", () => {
    insertEntry(db, "a1", "memory:m1");
    insertEntry(db, "a2", "entity:Manuel");
    insertEntry(db, "a3", "memory:m2");

    const result = gdprEraseAuditRecords(db, "target LIKE ?", ["%Manuel%"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(1);
    expect(count(db)).toBe(2);
  });

  test("handles full table erasure via LIKE wildcard", () => {
    insertEntry(db, "a1", "t1");
    insertEntry(db, "a2", "t2");
    insertEntry(db, "a3", "t3");

    const result = gdprEraseAuditRecords(db, "target LIKE ?", ["%"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(3);
    expect(count(db)).toBe(0);

    // Trigger should still be active
    insertEntry(db, "a4", "t4");
    expect(() => {
      db.query("DELETE FROM audit_log WHERE id = ?").run("a4");
    }).toThrow("Audit log entries cannot be deleted");
  });

  test("rejects unsafe filter clauses", () => {
    insertEntry(db, "a1", "t1");

    const unsafeFilters = [
      "1 = 1",
      "target = ? OR 1=1 --",
      "target = ?; DROP TABLE audit_log",
      "target = ? UNION SELECT * FROM audit_log",
    ];
    for (const filter of unsafeFilters) {
      const result = gdprEraseAuditRecords(db, filter, []);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("INVALID_INPUT");
      }
    }

    // Records should be untouched
    expect(count(db)).toBe(1);
  });
});
