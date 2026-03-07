/**
 * Tests for ScopedMemoryStore -- user-isolated memory operations.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import { ScopedMemoryStore } from "../memory-scope.ts";
import { DEFAULT_USER_ID } from "../schema.ts";

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

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const result = runMigrations(db, "memory", MEMORY_MIGRATIONS, createSilentLogger());
  if (!result.ok) {
    throw new Error(`Migration failed: ${result.error.message}`);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ScopedMemoryStore", () => {
  let db: Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  describe("user isolation", () => {
    test("memories are scoped to user", () => {
      const storeA = new ScopedMemoryStore(db, createSilentLogger(), "user-a");
      const storeB = new ScopedMemoryStore(db, createSilentLogger(), "user-b");

      storeA.create({
        type: "fact",
        layer: "long_term",
        content: "Alice likes cats",
        confidence: 0.9,
        source: "test",
      });

      storeB.create({
        type: "fact",
        layer: "long_term",
        content: "Bob likes dogs",
        confidence: 0.9,
        source: "test",
      });

      const listA = storeA.list();
      const listB = storeB.list();

      expect(listA.ok).toBe(true);
      expect(listB.ok).toBe(true);
      if (!listA.ok || !listB.ok) return;

      expect(listA.value).toHaveLength(1);
      expect(listA.value[0]?.content).toBe("Alice likes cats");

      expect(listB.value).toHaveLength(1);
      expect(listB.value[0]?.content).toBe("Bob likes dogs");
    });

    test("count is scoped to user", () => {
      const storeA = new ScopedMemoryStore(db, createSilentLogger(), "user-a");
      const storeB = new ScopedMemoryStore(db, createSilentLogger(), "user-b");

      storeA.create({
        type: "fact",
        layer: "long_term",
        content: "Fact 1",
        confidence: 0.9,
        source: "test",
      });
      storeA.create({
        type: "fact",
        layer: "long_term",
        content: "Fact 2",
        confidence: 0.9,
        source: "test",
      });
      storeB.create({
        type: "fact",
        layer: "long_term",
        content: "Fact 3",
        confidence: 0.9,
        source: "test",
      });

      const countA = storeA.count();
      const countB = storeB.count();

      expect(countA.ok).toBe(true);
      expect(countB.ok).toBe(true);
      if (!countA.ok || !countB.ok) return;

      expect(countA.value).toBe(2);
      expect(countB.value).toBe(1);
    });

    test("text search is scoped to user", () => {
      const storeA = new ScopedMemoryStore(db, createSilentLogger(), "user-a");
      const storeB = new ScopedMemoryStore(db, createSilentLogger(), "user-b");

      storeA.create({
        type: "fact",
        layer: "long_term",
        content: "TypeScript is great",
        confidence: 0.9,
        source: "test",
      });
      storeB.create({
        type: "fact",
        layer: "long_term",
        content: "TypeScript is awesome",
        confidence: 0.9,
        source: "test",
      });

      const searchA = storeA.searchText("TypeScript");
      const searchB = storeB.searchText("TypeScript");

      expect(searchA.ok).toBe(true);
      expect(searchB.ok).toBe(true);
      if (!searchA.ok || !searchB.ok) return;

      expect(searchA.value).toHaveLength(1);
      expect(searchA.value[0]?.memory.content).toBe("TypeScript is great");

      expect(searchB.value).toHaveLength(1);
      expect(searchB.value[0]?.memory.content).toBe("TypeScript is awesome");
    });
  });

  describe("backward compatibility", () => {
    test("defaults to DEFAULT_USER_ID", () => {
      const store = new ScopedMemoryStore(db, createSilentLogger());
      expect(store.scopedUserId).toBe(DEFAULT_USER_ID);
    });

    test("existing memories with default user_id are accessible", () => {
      const store = new ScopedMemoryStore(db, createSilentLogger());
      store.create({
        type: "fact",
        layer: "long_term",
        content: "Legacy memory",
        confidence: 0.9,
        source: "test",
      });

      const list = store.list();
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value).toHaveLength(1);
      expect(list.value[0]?.content).toBe("Legacy memory");
    });
  });

  describe("create", () => {
    test("creates memory with user_id set", () => {
      const store = new ScopedMemoryStore(db, createSilentLogger(), "user-x");
      const result = store.create({
        type: "preference",
        layer: "long_term",
        content: "Prefers dark mode",
        confidence: 0.8,
        source: "test",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.type).toBe("preference");

      // Verify user_id was set in the database
      const row = db.query("SELECT user_id FROM memories WHERE id = ?").get(result.value.id) as {
        user_id: string;
      } | null;
      expect(row?.user_id).toBe("user-x");
    });

    test("rejects content exceeding max length", () => {
      const store = new ScopedMemoryStore(db, createSilentLogger(), "user-x");
      const result = store.create({
        type: "fact",
        layer: "long_term",
        content: "x".repeat(1_048_577),
        confidence: 0.9,
        source: "test",
      });
      expect(result.ok).toBe(false);
    });

    test("rejects invalid confidence", () => {
      const store = new ScopedMemoryStore(db, createSilentLogger(), "user-x");
      const result = store.create({
        type: "fact",
        layer: "long_term",
        content: "test",
        confidence: 1.5,
        source: "test",
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("list with filters", () => {
    test("filters by type", () => {
      const store = new ScopedMemoryStore(db, createSilentLogger(), "user-a");
      store.create({
        type: "fact",
        layer: "long_term",
        content: "A fact",
        confidence: 0.9,
        source: "test",
      });
      store.create({
        type: "preference",
        layer: "long_term",
        content: "A pref",
        confidence: 0.9,
        source: "test",
      });

      const result = store.list({ types: ["fact"] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.type).toBe("fact");
    });

    test("filters by layer", () => {
      const store = new ScopedMemoryStore(db, createSilentLogger(), "user-a");
      store.create({
        type: "fact",
        layer: "long_term",
        content: "Long term",
        confidence: 0.9,
        source: "test",
      });
      store.create({
        type: "fact",
        layer: "short_term",
        content: "Short term",
        confidence: 0.9,
        source: "test",
      });

      const result = store.list({ layers: ["short_term"] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.content).toBe("Short term");
    });
  });
});
