import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { Logger } from "../../logging/logger.ts";
import { adjustSessionMemoryConfidence } from "../confidence.ts";

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

function createTestMemoryDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      layer TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      sensitive INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

function insertMemory(db: Database, sessionId: string, confidence: number): string {
  const id = randomUUID();
  const now = Date.now();
  db.query(
    `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    "fact",
    "short_term",
    "Test memory content",
    confidence,
    "extraction:rule_based",
    "[]",
    now,
    now,
    now,
    JSON.stringify({ sessionId }),
  );
  return id;
}

function getConfidence(db: Database, id: string): number {
  const row = db.query("SELECT confidence FROM memories WHERE id = ?").get(id) as {
    confidence: number;
  } | null;
  if (!row) throw new Error(`Memory ${id} not found`);
  return row.confidence;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("adjustSessionMemoryConfidence", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeDb(): Database {
    const db = createTestMemoryDb();
    databases.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  test("increases confidence for positive rating (5)", () => {
    const db = makeDb();
    const memId = insertMemory(db, "sess-1", 0.7);

    const updated = adjustSessionMemoryConfidence(db, "sess-1", 5, logger);

    expect(updated).toBe(1);
    expect(getConfidence(db, memId)).toBeCloseTo(0.75, 5);
  });

  test("increases confidence for positive rating (4)", () => {
    const db = makeDb();
    const memId = insertMemory(db, "sess-1", 0.8);

    const updated = adjustSessionMemoryConfidence(db, "sess-1", 4, logger);

    expect(updated).toBe(1);
    expect(getConfidence(db, memId)).toBeCloseTo(0.85, 5);
  });

  test("decreases confidence for negative rating (1)", () => {
    const db = makeDb();
    const memId = insertMemory(db, "sess-1", 0.7);

    const updated = adjustSessionMemoryConfidence(db, "sess-1", 1, logger);

    expect(updated).toBe(1);
    expect(getConfidence(db, memId)).toBeCloseTo(0.65, 5);
  });

  test("decreases confidence for negative rating (2)", () => {
    const db = makeDb();
    const memId = insertMemory(db, "sess-1", 0.5);

    const updated = adjustSessionMemoryConfidence(db, "sess-1", 2, logger);

    expect(updated).toBe(1);
    expect(getConfidence(db, memId)).toBeCloseTo(0.45, 5);
  });

  test("does not change confidence for neutral rating (3)", () => {
    const db = makeDb();
    const memId = insertMemory(db, "sess-1", 0.7);

    const updated = adjustSessionMemoryConfidence(db, "sess-1", 3, logger);

    expect(updated).toBe(0);
    expect(getConfidence(db, memId)).toBeCloseTo(0.7, 5);
  });

  test("clamps confidence to not go below 0", () => {
    const db = makeDb();
    const memId = insertMemory(db, "sess-1", 0.02);

    const updated = adjustSessionMemoryConfidence(db, "sess-1", 1, logger);

    expect(updated).toBe(1);
    expect(getConfidence(db, memId)).toBeGreaterThanOrEqual(0);
  });

  test("clamps confidence to not go above 1", () => {
    const db = makeDb();
    const memId = insertMemory(db, "sess-1", 0.98);

    const updated = adjustSessionMemoryConfidence(db, "sess-1", 5, logger);

    expect(updated).toBe(1);
    expect(getConfidence(db, memId)).toBeLessThanOrEqual(1);
  });

  test("adjusts multiple memories for the same session", () => {
    const db = makeDb();
    const memId1 = insertMemory(db, "sess-1", 0.7);
    const memId2 = insertMemory(db, "sess-1", 0.6);
    insertMemory(db, "sess-2", 0.8);

    const updated = adjustSessionMemoryConfidence(db, "sess-1", 5, logger);

    expect(updated).toBe(2);
    expect(getConfidence(db, memId1)).toBeCloseTo(0.75, 5);
    expect(getConfidence(db, memId2)).toBeCloseTo(0.65, 5);
  });

  test("returns 0 when no memories match the session", () => {
    const db = makeDb();
    insertMemory(db, "sess-other", 0.7);

    const updated = adjustSessionMemoryConfidence(db, "sess-nonexistent", 5, logger);

    expect(updated).toBe(0);
  });

  test("does not modify memories from other sessions", () => {
    const db = makeDb();
    insertMemory(db, "sess-1", 0.7);
    const otherMemId = insertMemory(db, "sess-2", 0.8);

    adjustSessionMemoryConfidence(db, "sess-1", 1, logger);

    expect(getConfidence(db, otherMemId)).toBeCloseTo(0.8, 5);
  });
});
