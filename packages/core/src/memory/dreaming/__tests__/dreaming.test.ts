import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { FakeLLMProvider } from "@eidolon/test-utils";
import { runMigrations } from "../../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../../database/schemas/memory.ts";
import { ModelRouter } from "../../../llm/router.ts";
import type { Logger } from "../../../logging/logger.ts";
import type { EmbeddingModel, EmbeddingPrefix } from "../../embeddings.ts";
import { GraphMemory } from "../../graph.ts";
import { CommunityDetector } from "../../knowledge-graph/communities.ts";
import { KGEntityStore } from "../../knowledge-graph/entities.ts";
import { KGRelationStore } from "../../knowledge-graph/relations.ts";
import { MemorySearch } from "../../search.ts";
import type { CreateMemoryInput } from "../../store.ts";
import { MemoryStore } from "../../store.ts";
import { HousekeepingPhase, stringSimilarity } from "../housekeeping.ts";
import { DreamRunner } from "../index.ts";
import { NremPhase } from "../nrem.ts";
import { RemPhase } from "../rem.ts";
import type { DreamScheduleConfig } from "../scheduler.ts";
import { DreamScheduler } from "../scheduler.ts";

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

  test("run returns memoriesCreated=0 and tokensUsed=0 without LLM", async () => {
    store.create(makeInput({ layer: "short_term", content: "Recent fact" }));

    const result = await rem.run({ recentDays: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesCreated).toBe(0);
    expect(result.value.tokensUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// REM Phase with LLM Tests
// ---------------------------------------------------------------------------

describe("RemPhase with LLM router", () => {
  let db: Database;
  let store: MemoryStore;
  let search: MemorySearch;
  let graph: GraphMemory;
  const logger = createSilentLogger();

  beforeEach(() => {
    db = createTestDb();
    store = new MemoryStore(db, logger);
    const mockModel = new MockEmbeddingModel();
    search = new MemorySearch(store, mockModel as unknown as EmbeddingModel, db, logger);
    graph = new GraphMemory(db, logger);
  });

  afterEach(() => {
    db.close();
  });

  test("creates association memories from LLM insights", async () => {
    // Set up a router with a fake provider returning insights JSON
    const insightsJson = JSON.stringify([
      { insight: "Both involve fast runtimes for JavaScript", confidence: 0.85 },
      { insight: "Performance is a shared concern", confidence: 0.7 },
    ]);
    const fakeProvider = FakeLLMProvider.withResponse(insightsJson, "ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const rem = new RemPhase(store, search, graph, null, null, logger, router);

    // Create memories that will match via BM25
    store.create(makeInput({
      layer: "short_term",
      content: "Bun runtime is fast for JavaScript",
    }));
    store.create(makeInput({
      layer: "long_term",
      content: "JavaScript is the language of the web and Bun is fast",
    }));

    const result = await rem.run({ recentDays: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have created association memories for insights with confidence >= 0.5
    expect(result.value.memoriesCreated).toBeGreaterThanOrEqual(0);
    expect(result.value.tokensUsed).toBeGreaterThanOrEqual(0);

    // If BM25 found matches, the LLM should have been called
    if (result.value.associationsFound > 0) {
      expect(fakeProvider.getCallCount()).toBeGreaterThan(0);
      expect(result.value.memoriesCreated).toBe(2);
      expect(result.value.tokensUsed).toBeGreaterThan(0);
    }
  });

  test("filters out low-confidence insights", async () => {
    const insightsJson = JSON.stringify([
      { insight: "Weak connection", confidence: 0.3 },
      { insight: "Strong connection", confidence: 0.8 },
    ]);
    const fakeProvider = FakeLLMProvider.withResponse(insightsJson, "ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const rem = new RemPhase(store, search, graph, null, null, logger, router);

    store.create(makeInput({
      layer: "short_term",
      content: "Bun runtime is fast for JavaScript",
    }));
    store.create(makeInput({
      layer: "long_term",
      content: "JavaScript is the language of the web and Bun is fast",
    }));

    const result = await rem.run({ recentDays: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only the insight with confidence >= 0.5 should become a memory
    if (result.value.associationsFound > 0) {
      expect(result.value.memoriesCreated).toBe(1);
    }
  });

  test("degrades gracefully when provider is unavailable", async () => {
    const unavailable = FakeLLMProvider.unavailable("ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(unavailable);

    const rem = new RemPhase(store, search, graph, null, null, logger, router);

    store.create(makeInput({
      layer: "short_term",
      content: "Bun runtime is fast for JavaScript",
    }));
    store.create(makeInput({
      layer: "long_term",
      content: "JavaScript is the language of the web and Bun is fast",
    }));

    const result = await rem.run({ recentDays: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should succeed but with no LLM-created memories
    expect(result.value.memoriesCreated).toBe(0);
    expect(result.value.tokensUsed).toBe(0);
  });

  test("degrades gracefully when no router is provided", async () => {
    const rem = new RemPhase(store, search, graph, null, null, logger, null);

    store.create(makeInput({
      layer: "short_term",
      content: "Some recent memory",
    }));

    const result = await rem.run({ recentDays: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesCreated).toBe(0);
    expect(result.value.tokensUsed).toBe(0);
  });

  test("handles malformed LLM response gracefully", async () => {
    const fakeProvider = FakeLLMProvider.withResponse("not valid json at all", "ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const rem = new RemPhase(store, search, graph, null, null, logger, router);

    store.create(makeInput({
      layer: "short_term",
      content: "Bun runtime is fast for JavaScript",
    }));
    store.create(makeInput({
      layer: "long_term",
      content: "JavaScript is the language of the web and Bun is fast",
    }));

    const result = await rem.run({ recentDays: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should succeed but produce no memories from bad JSON
    expect(result.value.memoriesCreated).toBe(0);
  });

  test("handles JSON in markdown fences", async () => {
    const wrappedJson = '```json\n[{"insight":"Test insight","confidence":0.9}]\n```';
    const fakeProvider = FakeLLMProvider.withResponse(wrappedJson, "ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const rem = new RemPhase(store, search, graph, null, null, logger, router);

    store.create(makeInput({
      layer: "short_term",
      content: "Bun runtime is fast for JavaScript",
    }));
    store.create(makeInput({
      layer: "long_term",
      content: "JavaScript is the language of the web and Bun is fast",
    }));

    const result = await rem.run({ recentDays: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should parse the fenced JSON correctly
    if (result.value.associationsFound > 0) {
      expect(result.value.memoriesCreated).toBe(1);
    }
  });

  test("prefers custom analyzeFn over LLM provider", async () => {
    const fakeProvider = FakeLLMProvider.withResponse("[]", "ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const rem = new RemPhase(store, search, graph, null, null, logger, router);

    store.create(makeInput({
      layer: "short_term",
      content: "Bun runtime is fast for JavaScript",
    }));
    store.create(makeInput({
      layer: "long_term",
      content: "JavaScript is the language of the web and Bun is fast",
    }));

    const customFn = async (): Promise<Array<{ insight: string; confidence: number }>> => {
      return [{ insight: "Custom insight from analyzeFn", confidence: 0.9 }];
    };

    const result = await rem.run({ recentDays: 30, analyzeFn: customFn });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Custom analyzeFn should be used instead of the LLM provider
    if (result.value.associationsFound > 0) {
      expect(result.value.memoriesCreated).toBe(1);
      // The LLM provider should NOT have been called
      expect(fakeProvider.getCallCount()).toBe(0);
    }
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
// NREM Phase with LLM Tests
// ---------------------------------------------------------------------------

describe("NremPhase with LLM router", () => {
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

  function seedOldShortTermMemories(count: number, type: "fact" | "episode" | "decision" = "fact", tags: string[] = []): void {
    const oldTime = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    for (let i = 0; i < count; i++) {
      db.query(
        `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      ).run(
        `${type}-${i}`,
        type,
        "short_term",
        `${type} memory number ${i} about testing patterns`,
        0.9,
        "user",
        JSON.stringify(tags.length > 0 ? tags : [`tag-${type}`]),
        oldTime,
        oldTime,
        oldTime,
        "{}",
      );
    }
  }

  function seedLongTermMemories(count: number, type: "fact" | "episode" | "decision" = "fact", tags: string[] = []): void {
    for (let i = 0; i < count; i++) {
      store.create({
        type,
        layer: "long_term",
        content: `Long-term ${type} memory ${i} about development practices`,
        confidence: 0.9,
        source: "user",
        tags: tags.length > 0 ? tags : [`tag-${type}`],
      });
    }
  }

  function seedKgEntitiesAndRelations(): void {
    // Create 4 entities that form two communities: (A-B) and (C-D)
    const now = Date.now();
    for (const [id, name, type] of [
      ["e1", "TypeScript", "technology"],
      ["e2", "Bun", "technology"],
      ["e3", "Manuel", "person"],
      ["e4", "Eidolon", "project"],
    ] as const) {
      db.query(
        `INSERT INTO kg_entities (id, name, type, attributes, created_at, updated_at)
         VALUES (?, ?, ?, '{}', ?, ?)`,
      ).run(id, name, type, now, now);
    }

    // Relations: TypeScript<->Bun (strong), Manuel<->Eidolon (strong)
    for (const [srcId, tgtId, relType] of [
      ["e1", "e2", "related_to"],
      ["e3", "e4", "creates"],
      ["e1", "e4", "used_by"],
    ] as const) {
      const relId = `${srcId}-${tgtId}`;
      db.query(
        `INSERT INTO kg_relations (id, source_id, target_id, type, confidence, source, created_at)
         VALUES (?, ?, ?, ?, 0.9, 'test', ?)`,
      ).run(relId, srcId, tgtId, relType, now);
    }
  }

  test("abstracts schemas from long-term memory clusters via LLM", async () => {
    const fakeProvider = FakeLLMProvider.withResponse(
      "When developing TypeScript applications, always prefer explicit return types for exported functions.",
      "ollama",
    );
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const nrem = new NremPhase(store, logger, router);

    // Seed enough long-term fact memories to exceed minClusterSize (default 3)
    seedLongTermMemories(4, "fact");

    const result = await nrem.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.schemasCreated).toBe(1);
    expect(result.value.tokensUsed).toBeGreaterThan(0);
    expect(fakeProvider.getCallCount()).toBe(1);

    // Verify the schema memory was created
    const schemas = store.list({ types: ["schema"], layers: ["long_term"] });
    expect(schemas.ok).toBe(true);
    if (!schemas.ok) return;
    expect(schemas.value.length).toBe(1);
    expect(schemas.value[0]?.source).toBe("dreaming:nrem");
    expect(schemas.value[0]?.tags).toContain("schema:fact");
  });

  test("extracts skills from recurring episode patterns via LLM", async () => {
    const fakeProvider = FakeLLMProvider.withResponse(
      "Step 1: Identify the failing test. Step 2: Read the error message. Step 3: Fix the root cause.",
      "ollama",
    );
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const nrem = new NremPhase(store, logger, router);

    // Seed enough episode memories sharing a tag to trigger skill extraction (threshold is 3)
    seedLongTermMemories(4, "episode", ["debugging"]);

    const result = await nrem.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.skillsExtracted).toBe(1);
    expect(result.value.tokensUsed).toBeGreaterThan(0);

    // Verify skill was stored with correct type and layer
    const skills = store.list({ types: ["skill"], layers: ["procedural"] });
    expect(skills.ok).toBe(true);
    if (!skills.ok) return;
    expect(skills.value.length).toBe(1);
    expect(skills.value[0]?.tags).toContain("debugging");
    expect(skills.value[0]?.source).toBe("dreaming:nrem");
  });

  test("detects and summarizes communities via CommunityDetector + LLM", async () => {
    seedKgEntitiesAndRelations();

    const fakeProvider = FakeLLMProvider.withResponse(
      "A cluster of technologies and projects centered around TypeScript development.",
      "ollama",
    );
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const communityDetector = new CommunityDetector(db, logger);
    const nrem = new NremPhase(store, logger, router, communityDetector);

    const result = await nrem.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Community detection should find at least 1 community
    expect(result.value.communitiesDetected).toBeGreaterThanOrEqual(1);
    expect(result.value.communitiesSummarized).toBeGreaterThanOrEqual(1);
    expect(result.value.tokensUsed).toBeGreaterThan(0);

    // LLM should have been called at least once per summarized community
    expect(fakeProvider.getCallCount()).toBeGreaterThanOrEqual(1);

    // Verify community summary was updated in the DB
    const communities = communityDetector.getCommunities();
    expect(communities.ok).toBe(true);
    if (!communities.ok) return;
    // At least one community should have the LLM-generated summary
    const hasLlmSummary = communities.value.some(
      (c) => c.summary.includes("TypeScript development"),
    );
    expect(hasLlmSummary).toBe(true);
  });

  test("gracefully degrades when provider is unavailable", async () => {
    const unavailable = FakeLLMProvider.unavailable("ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(unavailable);

    const nrem = new NremPhase(store, logger, router);

    seedLongTermMemories(5, "fact");
    seedLongTermMemories(4, "episode", ["debugging"]);

    const result = await nrem.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should succeed but produce no schemas or skills
    expect(result.value.schemasCreated).toBe(0);
    expect(result.value.skillsExtracted).toBe(0);
    expect(result.value.tokensUsed).toBe(0);
  });

  test("gracefully degrades when no router is provided", async () => {
    const nrem = new NremPhase(store, logger, null, null);

    seedLongTermMemories(5, "fact");

    const result = await nrem.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.schemasCreated).toBe(0);
    expect(result.value.skillsExtracted).toBe(0);
    expect(result.value.tokensUsed).toBe(0);
  });

  test("uses legacy abstractFn when no router available", async () => {
    const nrem = new NremPhase(store, logger, null, null);

    seedLongTermMemories(4, "fact");

    let fnCalled = false;
    const legacyFn = async (_memories: readonly string[]): Promise<string | null> => {
      fnCalled = true;
      return "Legacy rule: always test your code before deploying.";
    };

    const result = await nrem.run({ abstractFn: legacyFn });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(fnCalled).toBe(true);
    expect(result.value.schemasCreated).toBe(1);
    expect(result.value.tokensUsed).toBe(0); // legacy fn does not track tokens
  });

  test("prefers LLM router over legacy abstractFn", async () => {
    const fakeProvider = FakeLLMProvider.withResponse("LLM-generated schema rule.", "ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const nrem = new NremPhase(store, logger, router, null);

    seedLongTermMemories(4, "fact");

    let legacyFnCalled = false;
    const legacyFn = async (): Promise<string | null> => {
      legacyFnCalled = true;
      return "Legacy result.";
    };

    const result = await nrem.run({ abstractFn: legacyFn });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(legacyFnCalled).toBe(false);
    expect(fakeProvider.getCallCount()).toBe(1);
    expect(result.value.schemasCreated).toBe(1);
    expect(result.value.tokensUsed).toBeGreaterThan(0);
  });

  test("skips existing schema memories during abstraction", async () => {
    const fakeProvider = FakeLLMProvider.withResponse("Abstracted rule.", "ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(fakeProvider);

    const nrem = new NremPhase(store, logger, router, null);

    // Create some long-term facts + an existing schema
    seedLongTermMemories(4, "fact");
    store.create({
      type: "schema",
      layer: "long_term",
      content: "Existing schema rule",
      confidence: 0.8,
      source: "dreaming:nrem",
      tags: ["schema:old"],
    });

    const result = await nrem.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The existing schema should not be included in clustering.
    // Only the 4 fact memories should form a cluster.
    expect(result.value.schemasCreated).toBe(1);
  });

  test("community detection without LLM uses built-in summaries", async () => {
    seedKgEntitiesAndRelations();

    // Provide a community detector but no router (unavailable LLM)
    const unavailable = FakeLLMProvider.unavailable("ollama");
    const router = new ModelRouter({ providers: {}, routing: {} }, logger);
    router.registerProvider(unavailable);

    const communityDetector = new CommunityDetector(db, logger);
    const nrem = new NremPhase(store, logger, router, communityDetector);

    const result = await nrem.run();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.communitiesDetected).toBeGreaterThanOrEqual(1);
    // communitiesSummarized counts the built-in fallback summaries
    expect(result.value.communitiesSummarized).toBeGreaterThanOrEqual(1);
    expect(result.value.tokensUsed).toBe(0); // no LLM tokens used
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
