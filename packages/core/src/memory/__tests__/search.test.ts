import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.js";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.js";
import type { Logger } from "../../logging/logger.js";
import type { EmbeddingModel, EmbeddingPrefix } from "../embeddings.js";
import { MemorySearch } from "../search.js";
import type { CreateMemoryInput } from "../store.js";
import { MemoryStore } from "../store.js";

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

/**
 * Mock embedding model that produces deterministic embeddings based on
 * character codes. Avoids loading the real ONNX model in tests.
 */
class MockEmbeddingModel {
  initialized = true;

  get isInitialized(): boolean {
    return this.initialized;
  }

  async embed(text: string, _prefix?: EmbeddingPrefix): Promise<Result<Float32Array, EidolonError>> {
    return Ok(MockEmbeddingModel.deterministicEmbedding(text));
  }

  async embedBatch(texts: readonly string[]): Promise<Result<Float32Array[], EidolonError>> {
    const results: Float32Array[] = [];
    for (const t of texts) {
      results.push(MockEmbeddingModel.deterministicEmbedding(t));
    }
    return Ok(results);
  }

  static deterministicEmbedding(text: string): Float32Array {
    const arr = new Float32Array(384);
    for (let i = 0; i < 384; i++) {
      arr[i] = (text.charCodeAt(i % text.length) as number) / 128 - 1;
    }
    // Normalize to unit vector
    const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0));
    if (norm > 0) {
      for (let i = 0; i < 384; i++) {
        arr[i] = (arr[i] as number) / norm;
      }
    }
    return arr;
  }

  /**
   * Expose cosineSimilarity so it matches EmbeddingModel's static method signature.
   */
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
// Tests
// ---------------------------------------------------------------------------

describe("MemorySearch", () => {
  let db: Database;
  let store: MemoryStore;
  let search: MemorySearch;
  let mockModel: MockEmbeddingModel;

  beforeEach(() => {
    db = createTestDb();
    store = new MemoryStore(db, createSilentLogger());
    mockModel = new MockEmbeddingModel();
    search = new MemorySearch(store, mockModel as unknown as EmbeddingModel, db, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // fuseRRF
  // -----------------------------------------------------------------------

  test("fuseRRF combines two ranked lists correctly", () => {
    const list1 = [
      { id: "a", rank: 1 },
      { id: "b", rank: 2 },
      { id: "c", rank: 3 },
    ];
    const list2 = [
      { id: "b", rank: 1 },
      { id: "c", rank: 2 },
      { id: "d", rank: 3 },
    ];

    const result = MemorySearch.fuseRRF([list1, list2], [1, 1], 60);

    // "b" appears in both lists at ranks 2 and 1, should have highest score
    expect(result.length).toBe(4);
    expect(result[0]?.id).toBe("b"); // rank 2 in list1 + rank 1 in list2
    // Verify score for "b": 1/(60+2) + 1/(60+1) = 1/62 + 1/61
    const expectedBScore = 1 / 62 + 1 / 61;
    expect(result[0]?.score).toBeCloseTo(expectedBScore, 10);
  });

  test("fuseRRF handles single list", () => {
    const list = [
      { id: "x", rank: 1 },
      { id: "y", rank: 2 },
    ];

    const result = MemorySearch.fuseRRF([list], [1], 60);

    expect(result.length).toBe(2);
    expect(result[0]?.id).toBe("x");
    expect(result[0]?.score).toBeCloseTo(1 / 61, 10);
    expect(result[1]?.id).toBe("y");
    expect(result[1]?.score).toBeCloseTo(1 / 62, 10);
  });

  test("fuseRRF handles empty lists", () => {
    const result = MemorySearch.fuseRRF([], [], 60);
    expect(result).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // storeEmbedding / getEmbedding
  // -----------------------------------------------------------------------

  test("storeEmbedding and getEmbedding roundtrip", () => {
    const created = store.create(makeInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const embedding = MockEmbeddingModel.deterministicEmbedding("test text");
    const storeResult = search.storeEmbedding(created.value.id, embedding);
    expect(storeResult.ok).toBe(true);

    const getResult = search.getEmbedding(created.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value).not.toBeNull();
    if (!getResult.value) return;

    expect(getResult.value.length).toBe(384);
    // Verify values match
    for (let i = 0; i < 384; i++) {
      expect(getResult.value[i]).toBeCloseTo(embedding[i] as number, 5);
    }
  });

  test("getEmbedding returns null for missing", () => {
    const created = store.create(makeInput());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // No embedding stored yet
    const result = search.getEmbedding(created.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  // -----------------------------------------------------------------------
  // searchBm25
  // -----------------------------------------------------------------------

  test("searchBm25 returns ranked results from FTS5", () => {
    store.create(makeInput({ content: "Bun is a fast JavaScript runtime" }));
    store.create(makeInput({ content: "TypeScript adds type safety to JavaScript" }));
    store.create(makeInput({ content: "Rust is a systems programming language" }));

    const result = search.searchBm25("JavaScript", 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThanOrEqual(2);
    // All returned items should have positive rank
    for (const item of result.value) {
      expect(item.rank).toBeGreaterThan(0);
    }
  });

  // -----------------------------------------------------------------------
  // searchVector
  // -----------------------------------------------------------------------

  test("searchVector returns similarity-ranked results", async () => {
    // Create memories and store embeddings for them
    const m1 = store.create(makeInput({ content: "TypeScript programming language" }));
    const m2 = store.create(makeInput({ content: "JavaScript web development" }));
    const m3 = store.create(makeInput({ content: "Rust systems programming" }));
    expect(m1.ok && m2.ok && m3.ok).toBe(true);
    if (!m1.ok || !m2.ok || !m3.ok) return;

    // Store embeddings
    search.storeEmbedding(m1.value.id, MockEmbeddingModel.deterministicEmbedding("TypeScript programming language"));
    search.storeEmbedding(m2.value.id, MockEmbeddingModel.deterministicEmbedding("JavaScript web development"));
    search.storeEmbedding(m3.value.id, MockEmbeddingModel.deterministicEmbedding("Rust systems programming"));

    // Search for something close to TypeScript
    const queryEmb = MockEmbeddingModel.deterministicEmbedding("TypeScript programming language");
    const result = await search.searchVector(queryEmb, 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBe(3);
    // The exact match should be first with similarity ~1.0
    expect(result.value[0]?.similarity).toBeCloseTo(1.0, 3);
    expect(result.value[0]?.memoryId).toBe(m1.value.id);
  });

  // -----------------------------------------------------------------------
  // search() -- full hybrid
  // -----------------------------------------------------------------------

  test("search() combines BM25 and vector results", async () => {
    const m1 = store.create(makeInput({ content: "Bun is a fast JavaScript runtime" }));
    const m2 = store.create(makeInput({ content: "TypeScript adds type safety to JavaScript" }));
    const m3 = store.create(makeInput({ content: "Rust is a systems programming language" }));
    expect(m1.ok && m2.ok && m3.ok).toBe(true);
    if (!m1.ok || !m2.ok || !m3.ok) return;

    // Store embeddings
    search.storeEmbedding(m1.value.id, MockEmbeddingModel.deterministicEmbedding("Bun is a fast JavaScript runtime"));
    search.storeEmbedding(
      m2.value.id,
      MockEmbeddingModel.deterministicEmbedding("TypeScript adds type safety to JavaScript"),
    );
    search.storeEmbedding(
      m3.value.id,
      MockEmbeddingModel.deterministicEmbedding("Rust is a systems programming language"),
    );

    const result = await search.search({ text: "JavaScript" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should return results (at least the JavaScript-matching ones)
    expect(result.value.length).toBeGreaterThanOrEqual(1);
    // Each result should have a score > 0
    for (const r of result.value) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.matchReason.length).toBeGreaterThan(0);
    }
  });

  test("search() filters by type", async () => {
    store.create(makeInput({ type: "fact", content: "JavaScript is dynamic" }));
    store.create(makeInput({ type: "preference", content: "I prefer JavaScript" }));
    store.create(makeInput({ type: "skill", content: "JavaScript closures" }));

    const result = await search.search({
      text: "JavaScript",
      types: ["fact"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All returned results should be of type "fact"
    for (const r of result.value) {
      expect(r.memory.type).toBe("fact");
    }
    expect(result.value.length).toBe(1);
  });

  test("search() filters by minConfidence", async () => {
    store.create(makeInput({ content: "JavaScript basics", confidence: 0.3 }));
    store.create(makeInput({ content: "JavaScript advanced patterns", confidence: 0.9 }));

    const result = await search.search({
      text: "JavaScript",
      minConfidence: 0.5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const r of result.value) {
      expect(r.memory.confidence).toBeGreaterThanOrEqual(0.5);
    }
    expect(result.value.length).toBe(1);
  });

  test("search() respects limit", async () => {
    // Create many memories
    for (let i = 0; i < 10; i++) {
      store.create(makeInput({ content: `JavaScript fact number ${i}` }));
    }

    const result = await search.search({
      text: "JavaScript",
      limit: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeLessThanOrEqual(3);
  });

  test("search() works with embedding model not initialized (BM25 only)", async () => {
    mockModel.initialized = false;
    search = new MemorySearch(store, mockModel as unknown as EmbeddingModel, db, createSilentLogger());

    store.create(makeInput({ content: "JavaScript is versatile" }));
    store.create(makeInput({ content: "JavaScript runs everywhere" }));

    const result = await search.search({ text: "JavaScript" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should still return BM25 results even without vector search
    expect(result.value.length).toBeGreaterThanOrEqual(1);
    for (const r of result.value) {
      expect(r.matchReason).toBe("bm25");
    }
  });
});
