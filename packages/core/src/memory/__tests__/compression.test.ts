import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import { MemoryCompressor } from "../compression.ts";
import { MemoryStore, type CreateMemoryInput } from "../store.ts";

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
    layer: "short_term",
    content: "Some fact content",
    confidence: 0.9,
    source: "extraction:rule_based",
    tags: ["test"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryCompressor", () => {
  let db: Database;
  let store: MemoryStore;
  const logger = createSilentLogger();

  beforeEach(() => {
    db = createTestDb();
    store = new MemoryStore(db, logger);
  });

  afterEach(() => {
    db.close();
  });

  // -- strategy: none -------------------------------------------------------

  test("compress returns zero results when strategy is none", async () => {
    const compressor = new MemoryCompressor(store, logger, {
      config: { strategy: "none", threshold: 3 },
    });

    const result = await compressor.compress();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesCompressed).toBe(0);
    expect(result.value.summariesCreated).toBe(0);
    expect(result.value.removedMemoryIds).toHaveLength(0);
  });

  // -- strategy: progressive ------------------------------------------------

  test("progressive compression does nothing when under threshold", async () => {
    const compressor = new MemoryCompressor(store, logger, {
      config: { strategy: "progressive", threshold: 10 },
    });

    // Create just 3 memories (well under threshold of 10)
    for (let i = 0; i < 3; i++) {
      store.create(makeInput({ content: `Fact ${i}` }));
    }

    const result = await compressor.compress();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesCompressed).toBe(0);
    expect(result.value.summariesCreated).toBe(0);
  });

  test("progressive compression compresses when over threshold", async () => {
    const compressor = new MemoryCompressor(store, logger, {
      config: { strategy: "progressive", threshold: 3 },
    });

    // Create 6 short_term fact memories (exceeds threshold of 3)
    for (let i = 0; i < 6; i++) {
      store.create(makeInput({ content: `Fact number ${i}`, type: "fact" }));
    }

    const result = await compressor.compress();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have compressed some memories
    expect(result.value.memoriesCompressed).toBeGreaterThan(0);
    expect(result.value.summariesCreated).toBeGreaterThan(0);
    expect(result.value.removedMemoryIds.length).toBeGreaterThan(0);

    // Verify the summary was created in the store
    const listResult = store.list({ layers: ["long_term"] });
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    expect(listResult.value.length).toBeGreaterThan(0);

    // The summary should have the "compressed" tag
    const summary = listResult.value[0];
    expect(summary?.tags).toContain("compressed");
  });

  test("progressive compression preserves recent memories", async () => {
    const compressor = new MemoryCompressor(store, logger, {
      config: { strategy: "progressive", threshold: 4 },
    });

    // Create 8 short_term fact memories
    for (let i = 0; i < 8; i++) {
      store.create(makeInput({ content: `Fact number ${i}`, type: "fact" }));
    }

    const beforeCount = store.count(["fact"]);
    expect(beforeCount.ok).toBe(true);
    if (!beforeCount.ok) return;
    expect(beforeCount.value).toBe(8);

    await compressor.compress();

    // After compression, we should have:
    // - keepCount most recent memories (ceil(4/2) = 2) in short_term
    // - 1 summary in long_term
    // - The 6 oldest should be compressed and deleted
    const shortTermResult = store.list({ layers: ["short_term"], types: ["fact"] });
    expect(shortTermResult.ok).toBe(true);
    if (!shortTermResult.ok) return;
    expect(shortTermResult.value.length).toBe(2); // keepCount = ceil(4/2) = 2

    const longTermResult = store.list({ layers: ["long_term"], types: ["fact"] });
    expect(longTermResult.ok).toBe(true);
    if (!longTermResult.ok) return;
    expect(longTermResult.value.length).toBe(1); // 1 summary
  });

  // -- strategy: hierarchical -----------------------------------------------

  test("hierarchical compression groups by primary tag", async () => {
    const compressor = new MemoryCompressor(store, logger, {
      config: { strategy: "hierarchical", threshold: 3 },
    });

    // Create 5 memories with tag "typescript" (exceeds threshold)
    for (let i = 0; i < 5; i++) {
      store.create(makeInput({ content: `TS fact ${i}`, tags: ["typescript"] }));
    }

    // Create 2 memories with tag "python" (under threshold)
    for (let i = 0; i < 2; i++) {
      store.create(makeInput({ content: `PY fact ${i}`, tags: ["python"] }));
    }

    const result = await compressor.compress();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only the typescript group should be compressed
    expect(result.value.memoriesCompressed).toBeGreaterThan(0);
    expect(result.value.summariesCreated).toBe(1);

    // Python memories should still be intact
    const allResult = store.list({ layers: ["short_term"] });
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;

    const pythonMemories = allResult.value.filter((m) => m.tags.includes("python"));
    expect(pythonMemories).toHaveLength(2);
  });

  // -- fallbackSummarize ----------------------------------------------------

  test("fallbackSummarize deduplicates and concatenates", () => {
    const result = MemoryCompressor.fallbackSummarize([
      "TypeScript is typed",
      "Bun is fast",
      "typescript is typed", // duplicate (case-insensitive)
    ]);

    expect(result).toContain("Consolidated from 2 memories:");
    expect(result).toContain("- TypeScript is typed");
    expect(result).toContain("- Bun is fast");
  });

  test("fallbackSummarize returns single content as-is", () => {
    const result = MemoryCompressor.fallbackSummarize(["Only one memory"]);
    expect(result).toBe("Only one memory");
  });

  // -- custom summarize function --------------------------------------------

  test("compress uses custom summarize function when provided", async () => {
    const compressor = new MemoryCompressor(store, logger, {
      config: { strategy: "progressive", threshold: 3 },
      summarizeFn: async (contents) => `Custom summary of ${contents.length} items`,
    });

    for (let i = 0; i < 6; i++) {
      store.create(makeInput({ content: `Fact ${i}`, type: "fact" }));
    }

    const result = await compressor.compress();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Check the summary content uses the custom function
    const longTermResult = store.list({ layers: ["long_term"] });
    expect(longTermResult.ok).toBe(true);
    if (!longTermResult.ok) return;
    expect(longTermResult.value.length).toBeGreaterThan(0);
    expect(longTermResult.value[0]?.content).toContain("Custom summary");
  });

  test("compress falls back to concatenation when custom summarize throws", async () => {
    const compressor = new MemoryCompressor(store, logger, {
      config: { strategy: "progressive", threshold: 3 },
      summarizeFn: async () => {
        throw new Error("LLM unavailable");
      },
    });

    for (let i = 0; i < 6; i++) {
      store.create(makeInput({ content: `Fact ${i}`, type: "fact" }));
    }

    const result = await compressor.compress();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should still succeed using fallback
    expect(result.value.summariesCreated).toBeGreaterThan(0);

    const longTermResult = store.list({ layers: ["long_term"] });
    expect(longTermResult.ok).toBe(true);
    if (!longTermResult.ok) return;
    expect(longTermResult.value.length).toBeGreaterThan(0);
    // Fallback summary starts with "Consolidated from"
    expect(longTermResult.value[0]?.content).toContain("Consolidated from");
  });
});
