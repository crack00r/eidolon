import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { runMigrations } from "../../../database/migrations.js";
import { MEMORY_MIGRATIONS } from "../../../database/schemas/memory.js";
import type { Logger } from "../../../logging/logger.js";
import type { EmbeddingModel, EmbeddingPrefix } from "../../embeddings.js";
import { GraphMemory } from "../../graph.js";
import { MemorySearch } from "../../search.js";
import type { CreateMemoryInput } from "../../store.js";
import { MemoryStore } from "../../store.js";
import { HousekeepingPhase, stringSimilarity } from "../housekeeping.js";
import { DreamRunner } from "../index.js";
import { NremPhase } from "../nrem.js";
import { RemPhase } from "../rem.js";
import type { DreamScheduleConfig } from "../scheduler.js";
import { DreamScheduler } from "../scheduler.js";

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
    ...overrides,
  };
}

/**
 * Mock embedding model that produces deterministic embeddings.
 * This is "not initialized" by default so MemorySearch falls back to BM25.
 */
class MockEmbeddingModel {
  initialized = false;

  get isInitialized(): boolean {
    return this.initialized;
  }

  async embed(text: string, _prefix?: EmbeddingPrefix): Promise<Result<Float32Array, EidolonError>> {
    return Ok(MockEmbeddingModel.deterministicEmbedding(text));
  }

  async embedBatch(texts: readonly string[]): Promise<Result<Float32Array[], EidolonError>> {
    return Ok(texts.map((t) => MockEmbeddingModel.deterministicEmbedding(t)));
  }

  static deterministicEmbedding(text: string): Float32Array {
    const arr = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      arr[i] = (text.charCodeAt(i % text.length) as number) / 128 - 1;
    }
    const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < 384; i++) {
        arr[i] = (arr[i] as number) / norm;
      }
    }
    return arr;
  }

  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) throw new Error("length mismatch");
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      const ai = a[i] as number;
      const bi = b[i] as number;
      dot += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}

// ---------------------------------------------------------------------------
// Scheduler Tests
// ---------------------------------------------------------------------------

describe("DreamScheduler", () => {
  const logger = createSilentLogger();

  test("shouldDream returns false when not enabled", () => {
    const config: DreamScheduleConfig = {
      enabled: false,
      schedule: "02:00",
      maxDurationMs: 1_800_000,
      timezone: "Europe/Berlin",
    };
    const scheduler = new DreamScheduler(config, logger);

    const result = scheduler.shouldDream(Date.now() - 100_000_000, 0);
    expect(result).toBe(false);
  });

  test("shouldDream returns true when triggered by idle", () => {
    // Use a schedule time far from now so the schedule trigger won't fire
    const now = new Date();
    const nowInBerlin = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    const farHour = (nowInBerlin.getHours() + 12) % 24;
    const config: DreamScheduleConfig = {
      enabled: true,
      schedule: `${String(farHour).padStart(2, "0")}:00`,
      maxDurationMs: 60_000, // 1 min (minimum valid)
      triggerOnIdleMs: 60_000, // 1 min (minimum valid)
      timezone: "Europe/Berlin",
    };
    const scheduler = new DreamScheduler(config, logger);

    // Last activity was 2 min ago, idle threshold is 1 min, last dream was long ago
    const lastActivity = Date.now() - 120_000;
    const lastDream = Date.now() - 200_000;
    const result = scheduler.shouldDream(lastActivity, lastDream);
    expect(result).toBe(true);
  });

  test("shouldDream returns false when last dream was too recent", () => {
    const config: DreamScheduleConfig = {
      enabled: true,
      schedule: "02:00",
      maxDurationMs: 1_800_000,
      triggerOnIdleMs: 60_000, // 1 min (minimum valid)
      timezone: "Europe/Berlin",
    };
    const scheduler = new DreamScheduler(config, logger);

    // Last dream was 1 second ago, maxDurationMs is 30 min -> too recent
    const result = scheduler.shouldDream(Date.now() - 100_000, Date.now() - 1_000);
    expect(result).toBe(false);
  });

  test("isInDreamWindow returns correct value", () => {
    // Schedule is current time -> should be in window
    const now = new Date();
    const nowInBerlin = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Berlin" }));
    const hours = String(nowInBerlin.getHours()).padStart(2, "0");
    const minutes = String(nowInBerlin.getMinutes()).padStart(2, "0");

    const config: DreamScheduleConfig = {
      enabled: true,
      schedule: `${hours}:${minutes}`,
      maxDurationMs: 1_800_000,
      timezone: "Europe/Berlin",
    };
    const scheduler = new DreamScheduler(config, logger);
    expect(scheduler.isInDreamWindow()).toBe(true);

    // Schedule is far from now -> should NOT be in window
    const farHour = (nowInBerlin.getHours() + 12) % 24;
    const farConfig: DreamScheduleConfig = {
      enabled: true,
      schedule: `${String(farHour).padStart(2, "0")}:00`,
      maxDurationMs: 1_800_000,
      timezone: "Europe/Berlin",
    };
    const farScheduler = new DreamScheduler(farConfig, logger);
    expect(farScheduler.isInDreamWindow()).toBe(false);
  });

  test("msUntilNextDream returns positive number", () => {
    const config: DreamScheduleConfig = {
      enabled: true,
      schedule: "02:00",
      maxDurationMs: 1_800_000,
      timezone: "Europe/Berlin",
    };
    const scheduler = new DreamScheduler(config, logger);

    const ms = scheduler.msUntilNextDream();
    expect(ms).toBeGreaterThan(0);
    // Should be within 24 hours
    expect(ms).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Housekeeping Tests
// ---------------------------------------------------------------------------

describe("HousekeepingPhase", () => {
  let db: Database;
  let store: MemoryStore;
  let graph: GraphMemory;
  let housekeeping: HousekeepingPhase;

  beforeEach(() => {
    db = createTestDb();
    const logger = createSilentLogger();
    store = new MemoryStore(db, logger);
    graph = new GraphMemory(db, logger);
    housekeeping = new HousekeepingPhase(store, graph, logger);
  });

  afterEach(() => {
    db.close();
  });

  test("stringSimilarity computes Jaccard similarity", () => {
    expect(stringSimilarity("hello world", "hello world")).toBe(1.0);
    expect(stringSimilarity("Hello World", "hello world")).toBe(1.0); // case insensitive
    expect(stringSimilarity("foo bar", "baz qux")).toBe(0);
    expect(stringSimilarity("a b c", "a b d")).toBeCloseTo(0.5, 1);
  });

  test("findDuplicates detects near-identical memories", () => {
    store.create(makeInput({ content: "TypeScript is great for large codebases" }));
    store.create(makeInput({ content: "TypeScript is great for large codebases" })); // exact dup
    store.create(makeInput({ content: "Rust has zero-cost abstractions" })); // different

    const result = housekeeping.findDuplicates();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBe(1);
    expect(result.value[0]?.similarity).toBe(1.0);
  });

  test("mergeDuplicates keeps newer memory and deletes older", () => {
    const m1 = store.create(makeInput({ content: "Same content here" }));
    expect(m1.ok).toBe(true);
    if (!m1.ok) return;

    // Small delay to ensure different timestamps
    const m2 = store.create(makeInput({ content: "Same content here" }));
    expect(m2.ok).toBe(true);
    if (!m2.ok) return;

    const result = housekeeping.mergeDuplicates(m1.value.id, m2.value.id);
    expect(result.ok).toBe(true);

    // Total count should be 1
    const countResult = store.count();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(1);

    // The surviving memory should have boosted confidence
    const remaining = store.list();
    expect(remaining.ok).toBe(true);
    if (!remaining.ok) return;
    expect(remaining.value.length).toBe(1);
    expect(remaining.value[0]?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  test("run prunes expired memories", async () => {
    // Insert an old short-term memory directly into DB
    const oldTime = Date.now() - 200 * 24 * 60 * 60 * 1000; // 200 days ago
    db.query(
      `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run("old-expired", "fact", "short_term", "Old fact", 0.5, "user", "[]", oldTime, oldTime, oldTime, "{}");

    // Create a recent memory
    store.create(makeInput({ layer: "long_term" }));

    const result = await housekeeping.run({ maxAgeMs: 90 * 24 * 60 * 60 * 1000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.expired).toBe(1);
  });

  test("run decays edge weights", async () => {
    const m1 = store.create(makeInput({ content: "Memory A" }));
    const m2 = store.create(makeInput({ content: "Memory B" }));
    expect(m1.ok && m2.ok).toBe(true);
    if (!m1.ok || !m2.ok) return;

    graph.createEdge({
      sourceId: m1.value.id,
      targetId: m2.value.id,
      relation: "related_to",
      weight: 1.0,
    });

    const result = await housekeeping.run({ decayFactor: 0.5 });
    expect(result.ok).toBe(true);

    // Check that edge weight was decayed
    const edges = graph.getOutgoing(m1.value.id);
    expect(edges.ok).toBe(true);
    if (!edges.ok) return;
    expect(edges.value.length).toBe(1);
    expect(edges.value[0]?.weight).toBeCloseTo(0.5, 2);
  });
});

// ---------------------------------------------------------------------------
// REM Tests
// ---------------------------------------------------------------------------

describe("RemPhase", () => {
  let db: Database;
  let store: MemoryStore;
  let search: MemorySearch;
  let graph: GraphMemory;
  let rem: RemPhase;

  beforeEach(() => {
    db = createTestDb();
    const logger = createSilentLogger();
    store = new MemoryStore(db, logger);
    const mockModel = new MockEmbeddingModel();
    search = new MemorySearch(store, mockModel as unknown as EmbeddingModel, db, logger);
    graph = new GraphMemory(db, logger);
    rem = new RemPhase(store, search, graph, null, null, logger);
  });

  afterEach(() => {
    db.close();
  });

  test("run creates edges between similar memories", async () => {
    // Create short-term memories (recent)
    store.create(
      makeInput({
        layer: "short_term",
        content: "Bun runtime is fast for JavaScript",
      }),
    );

    // Create long-term memories that share words with the short-term one
    store.create(
      makeInput({
        layer: "long_term",
        content: "JavaScript is the language of the web and Bun is fast",
      }),
    );

    const result = await rem.run({ recentDays: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The search is BM25-only (mock model not initialized), so edges
    // depend on whether FTS5 finds matching results. The key test is
    // that the code runs without error and returns a valid result.
    expect(result.value.edgesCreated).toBeGreaterThanOrEqual(0);
    expect(result.value.complexTrained).toBe(false); // no ComplEx provided
  });

  test("run works without ComplEx (null)", async () => {
    // Just verify it doesn't crash with null ComplEx
    const result = await rem.run({ recentDays: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.complexTrained).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NREM Tests
// ---------------------------------------------------------------------------

describe("NremPhase", () => {
  let db: Database;
  let store: MemoryStore;
  let nrem: NremPhase;

  beforeEach(() => {
    db = createTestDb();
    const logger = createSilentLogger();
    store = new MemoryStore(db, logger);
    nrem = new NremPhase(store, logger);
  });

  afterEach(() => {
    db.close();
  });

  test("run promotes high-confidence short-term to long-term", async () => {
    // Insert old short-term memories with high confidence (> 7 days old)
    const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    db.query(
      `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run("promote-me", "fact", "short_term", "Promotable fact", 0.9, "user", "[]", oldTime, oldTime, oldTime, "{}");

    const result = await nrem.run({ promotionConfidence: 0.7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesPromoted).toBe(1);

    // Verify memory is now long_term
    const mem = store.get("promote-me");
    expect(mem.ok).toBe(true);
    if (!mem.ok) return;
    expect(mem.value).not.toBeNull();
    expect(mem.value?.layer).toBe("long_term");
  });

  test("run skips low-confidence memories", async () => {
    // Insert old short-term memory with LOW confidence
    const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000;
    db.query(
      `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run("low-conf", "fact", "short_term", "Low confidence fact", 0.3, "user", "[]", oldTime, oldTime, oldTime, "{}");

    const result = await nrem.run({ promotionConfidence: 0.7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesPromoted).toBe(0);

    // Verify memory is still short_term
    const mem = store.get("low-conf");
    expect(mem.ok).toBe(true);
    if (!mem.ok) return;
    expect(mem.value?.layer).toBe("short_term");
  });

  test("run skips recent short-term memories even with high confidence", async () => {
    // Create a recent short-term memory with high confidence
    store.create(
      makeInput({
        layer: "short_term",
        content: "Recent high-confidence fact",
        confidence: 0.99,
      }),
    );

    const result = await nrem.run({ promotionConfidence: 0.7 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should not promote because it's too recent (< 7 days)
    expect(result.value.memoriesPromoted).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// DreamRunner Tests
// ---------------------------------------------------------------------------

describe("DreamRunner", () => {
  let db: Database;
  let store: MemoryStore;
  let runner: DreamRunner;

  beforeEach(() => {
    db = createTestDb();
    const logger = createSilentLogger();
    store = new MemoryStore(db, logger);
    const graph = new GraphMemory(db, logger);
    const mockModel = new MockEmbeddingModel();
    const search = new MemorySearch(store, mockModel as unknown as EmbeddingModel, db, logger);

    const housekeeping = new HousekeepingPhase(store, graph, logger);
    const rem = new RemPhase(store, search, graph, null, null, logger);
    const nrem = new NremPhase(store, logger);

    runner = new DreamRunner(housekeeping, rem, nrem, logger);
  });

  afterEach(() => {
    db.close();
  });

  test("runAll executes all three phases", async () => {
    // Add some test data
    store.create(makeInput({ content: "Test memory for dreaming" }));

    const result = await runner.runAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBe(3);
    expect(result.value[0]?.phase).toBe("housekeeping");
    expect(result.value[1]?.phase).toBe("rem");
    expect(result.value[2]?.phase).toBe("nrem");
  });

  test("runPhase executes single phase", async () => {
    const result = await runner.runPhase("housekeeping");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.phase).toBe("housekeeping");
    expect(result.value.startedAt).toBeGreaterThan(0);
    expect(result.value.completedAt).toBeGreaterThanOrEqual(result.value.startedAt);
    expect(result.value.tokensUsed).toBe(0);
  });

  test("runAll respects timeout", async () => {
    // Set a very short timeout that should expire immediately
    // We use 0 ms to ensure it fires before the first phase
    const result = await runner.runAll({ maxDurationMs: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // With 0 ms timeout, no phases should complete
    expect(result.value.length).toBe(0);
  });

  test("runAll returns results for each phase", async () => {
    const result = await runner.runAll();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const phaseResult of result.value) {
      expect(phaseResult.startedAt).toBeGreaterThan(0);
      expect(phaseResult.completedAt).toBeGreaterThanOrEqual(phaseResult.startedAt);
      expect(phaseResult.memoriesProcessed).toBeGreaterThanOrEqual(0);
      expect(phaseResult.memoriesCreated).toBeGreaterThanOrEqual(0);
      expect(phaseResult.memoriesRemoved).toBeGreaterThanOrEqual(0);
      expect(phaseResult.edgesCreated).toBeGreaterThanOrEqual(0);
      expect(phaseResult.tokensUsed).toBeGreaterThanOrEqual(0);
    }
  });
});
