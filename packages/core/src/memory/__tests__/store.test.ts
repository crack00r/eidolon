import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import type { CreateMemoryInput } from "../store.ts";
import { MemoryStore } from "../store.ts";

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

function makeInput(overrides?: Partial<CreateMemoryInput>): CreateMemoryInput {
  return {
    type: "fact",
    layer: "long_term",
    content: "TypeScript is a typed superset of JavaScript",
    confidence: 0.95,
    source: "user",
    tags: ["typescript", "programming"],
    metadata: { category: "tech" },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryStore", () => {
  let db: Database;
  let store: MemoryStore;

  beforeEach(() => {
    db = createTestDb();
    store = new MemoryStore(db, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  // -- create ---------------------------------------------------------------

  test("create() stores a memory and returns it", () => {
    const result = store.create(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mem = result.value;
    expect(mem.id).toBeDefined();
    expect(mem.type).toBe("fact");
    expect(mem.layer).toBe("long_term");
    expect(mem.content).toBe("TypeScript is a typed superset of JavaScript");
    expect(mem.confidence).toBe(0.95);
    expect(mem.source).toBe("user");
    expect(mem.accessCount).toBe(0);
    expect(mem.createdAt).toBeGreaterThan(0);
  });

  test("create() generates unique IDs", () => {
    const r1 = store.create(makeInput());
    const r2 = store.create(makeInput());
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r1.value.id).not.toBe(r2.value.id);
  });

  test("create() stores tags as JSON array", () => {
    const result = store.create(makeInput({ tags: ["a", "b", "c"] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify directly in SQLite that tags is stored as JSON
    const row = db.query("SELECT tags FROM memories WHERE id = ?").get(result.value.id) as { tags: string };
    expect(row.tags).toBe('["a","b","c"]');

    // Verify the returned Memory has parsed tags
    expect(result.value.tags).toEqual(["a", "b", "c"]);
  });

  test("create() stores metadata as JSON", () => {
    const meta = { key: "value", num: 42 };
    const result = store.create(makeInput({ metadata: meta }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = db.query("SELECT metadata FROM memories WHERE id = ?").get(result.value.id) as { metadata: string };
    expect(JSON.parse(row.metadata)).toEqual(meta);
    expect(result.value.metadata).toEqual(meta);
  });

  // -- get ------------------------------------------------------------------

  test("get() returns memory by ID", () => {
    const created = store.create(makeInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = store.get(created.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const mem = result.value;
    expect(mem).not.toBeNull();
    if (!mem) return;
    expect(mem.id).toBe(created.value.id);
    expect(mem.content).toBe(created.value.content);
  });

  test("get() updates accessed_at and access_count", () => {
    const created = store.create(makeInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // First get: access_count should become 1
    const first = store.get(created.value.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstMem = first.value;
    if (!firstMem) return;
    expect(firstMem.accessCount).toBe(1);

    // Second get: access_count should become 2
    const second = store.get(created.value.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const secondMem = second.value;
    if (!secondMem) return;
    expect(secondMem.accessCount).toBe(2);
    expect(secondMem.accessedAt).toBeGreaterThanOrEqual(firstMem.accessedAt);
  });

  test("get() returns null for unknown ID", () => {
    const result = store.get("nonexistent-id");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  // -- update ---------------------------------------------------------------

  test("update() modifies content", () => {
    const created = store.create(makeInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = store.update(created.value.id, { content: "Updated content" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.content).toBe("Updated content");
    expect(result.value.updatedAt).toBeGreaterThanOrEqual(created.value.updatedAt);
  });

  test("update() modifies confidence", () => {
    const created = store.create(makeInput({ confidence: 0.5 }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = store.update(created.value.id, { confidence: 0.9 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.confidence).toBe(0.9);
  });

  test("update() returns error for non-existent ID", () => {
    const result = store.update("nonexistent-id", { content: "nope" });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("DB_QUERY_FAILED");
    expect(result.error.message).toContain("not found");
  });

  // -- delete ---------------------------------------------------------------

  test("delete() removes memory", () => {
    const created = store.create(makeInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const delResult = store.delete(created.value.id);
    expect(delResult.ok).toBe(true);

    const getResult = store.get(created.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value).toBeNull();
  });

  // -- list -----------------------------------------------------------------

  test("list() returns all memories", () => {
    store.create(makeInput({ content: "Memory 1" }));
    store.create(makeInput({ content: "Memory 2" }));
    store.create(makeInput({ content: "Memory 3" }));

    const result = store.list();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(3);
  });

  test("list() filters by type", () => {
    store.create(makeInput({ type: "fact", content: "Fact 1" }));
    store.create(makeInput({ type: "preference", content: "Pref 1" }));
    store.create(makeInput({ type: "fact", content: "Fact 2" }));

    const result = store.list({ types: ["fact"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    expect(result.value.every((m) => m.type === "fact")).toBe(true);
  });

  test("list() filters by layer and confidence", () => {
    store.create(makeInput({ layer: "working", confidence: 0.3 }));
    store.create(makeInput({ layer: "working", confidence: 0.8 }));
    store.create(makeInput({ layer: "long_term", confidence: 0.9 }));

    const result = store.list({ layers: ["working"], minConfidence: 0.5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.confidence).toBe(0.8);
  });

  test("list() supports pagination (limit/offset)", () => {
    for (let i = 0; i < 5; i++) {
      store.create(makeInput({ content: `Memory ${i}` }));
    }

    const page1 = store.list({ limit: 2, offset: 0, orderBy: "created_at", order: "asc" });
    expect(page1.ok).toBe(true);
    if (!page1.ok) return;
    expect(page1.value).toHaveLength(2);

    const page2 = store.list({ limit: 2, offset: 2, orderBy: "created_at", order: "asc" });
    expect(page2.ok).toBe(true);
    if (!page2.ok) return;
    expect(page2.value).toHaveLength(2);

    // Ensure no overlap
    const ids1 = new Set(page1.value.map((m) => m.id));
    const overlap = page2.value.filter((m) => ids1.has(m.id));
    expect(overlap).toHaveLength(0);
  });

  // -- count ----------------------------------------------------------------

  test("count() returns correct count", () => {
    store.create(makeInput({ type: "fact" }));
    store.create(makeInput({ type: "fact" }));
    store.create(makeInput({ type: "preference" }));

    const allResult = store.count();
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;
    expect(allResult.value).toBe(3);

    const factResult = store.count(["fact"]);
    expect(factResult.ok).toBe(true);
    if (!factResult.ok) return;
    expect(factResult.value).toBe(2);
  });

  // -- searchText -----------------------------------------------------------

  test("searchText() finds memories by content", () => {
    store.create(makeInput({ content: "Bun is a fast JavaScript runtime" }));
    store.create(makeInput({ content: "TypeScript adds type safety to JavaScript" }));
    store.create(makeInput({ content: "Rust is a systems programming language" }));

    const result = store.searchText("JavaScript");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThanOrEqual(2);
    // All results should mention JavaScript
    for (const r of result.value) {
      expect(r.memory.content.toLowerCase()).toContain("javascript");
    }
    // Ranks should be positive (negated from FTS5)
    for (const r of result.value) {
      expect(r.rank).toBeGreaterThan(0);
    }
  });

  // -- pruneExpired ---------------------------------------------------------

  test("pruneExpired() removes old short_term memories", () => {
    // Create a short_term memory with an old timestamp by inserting directly
    const oldTime = Date.now() - 100_000;
    db.query(
      `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run("old-1", "fact", "short_term", "Old memory", 0.5, "user", "[]", oldTime, oldTime, oldTime, "{}");

    // Create a recent short_term memory
    store.create(makeInput({ layer: "short_term" }));

    // Create a long_term memory (should not be pruned)
    store.create(makeInput({ layer: "long_term" }));

    const cutoff = Date.now() - 50_000;
    const result = store.pruneExpired(cutoff);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBe(1); // Only the old short_term memory

    // Verify total remaining
    const countResult = store.count();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(2);
  });

  // -- createBatch ----------------------------------------------------------

  test("createBatch() creates multiple memories in transaction", () => {
    const inputs: CreateMemoryInput[] = [
      makeInput({ content: "Batch 1" }),
      makeInput({ content: "Batch 2", type: "preference" }),
      makeInput({ content: "Batch 3", type: "skill" }),
    ];

    const result = store.createBatch(inputs);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(3);
    expect(result.value[0]?.content).toBe("Batch 1");
    expect(result.value[1]?.type).toBe("preference");
    expect(result.value[2]?.type).toBe("skill");

    // Verify all are in the database
    const countResult = store.count();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(3);
  });
});
