import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.js";
import { EmbeddingModel } from "../embeddings.js";

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

// ---------------------------------------------------------------------------
// cosineSimilarity -- pure math, no model needed
// ---------------------------------------------------------------------------

describe("EmbeddingModel.cosineSimilarity", () => {
  test("returns 1.0 for identical normalized vectors", () => {
    // Normalized vector: [1/sqrt(3), 1/sqrt(3), 1/sqrt(3)]
    const norm = 1 / Math.sqrt(3);
    const v = new Float32Array([norm, norm, norm]);
    const similarity = EmbeddingModel.cosineSimilarity(v, v);
    expect(Math.abs(similarity - 1.0)).toBeLessThan(1e-6);
  });

  test("returns 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    const similarity = EmbeddingModel.cosineSimilarity(a, b);
    expect(Math.abs(similarity)).toBeLessThan(1e-6);
  });

  test("returns -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    const similarity = EmbeddingModel.cosineSimilarity(a, b);
    expect(Math.abs(similarity + 1.0)).toBeLessThan(1e-6);
  });

  test("computes correct similarity for known vectors", () => {
    // a = [3, 4], b = [4, 3]
    // dot = 12 + 12 = 24
    // |a| = 5, |b| = 5
    // cosine = 24/25 = 0.96
    const a = new Float32Array([3, 4]);
    const b = new Float32Array([4, 3]);
    const similarity = EmbeddingModel.cosineSimilarity(a, b);
    expect(Math.abs(similarity - 0.96)).toBeLessThan(1e-6);
  });

  test("returns 0.0 for zero vectors", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    const similarity = EmbeddingModel.cosineSimilarity(a, b);
    expect(similarity).toBe(0);
  });

  test("throws on mismatched vector lengths", () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => EmbeddingModel.cosineSimilarity(a, b)).toThrow("Vector length mismatch");
  });
});

// ---------------------------------------------------------------------------
// Initialization guard -- no model needed
// ---------------------------------------------------------------------------

describe("EmbeddingModel (uninitialized)", () => {
  test("isInitialized returns false before initialize()", () => {
    const model = new EmbeddingModel(createSilentLogger());
    expect(model.isInitialized).toBe(false);
  });

  test("embed() returns error when not initialized", async () => {
    const model = new EmbeddingModel(createSilentLogger());
    const result = await model.embed("Hello world");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EMBEDDING_FAILED");
    expect(result.error.message).toContain("not initialized");
  });

  test("embedBatch() returns error when not initialized", async () => {
    const model = new EmbeddingModel(createSilentLogger());
    const result = await model.embedBatch(["Hello", "World"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("EMBEDDING_FAILED");
    expect(result.error.message).toContain("not initialized");
  });
});

// ---------------------------------------------------------------------------
// Slow tests -- require model download (~130MB)
// Set RUN_SLOW_TESTS=1 to enable
// ---------------------------------------------------------------------------

const RUN_SLOW = process.env.RUN_SLOW_TESTS === "1";

describe.skipIf(!RUN_SLOW)("EmbeddingModel (with model)", () => {
  test("initialize() loads the model", async () => {
    const model = new EmbeddingModel(createSilentLogger());
    const result = await model.initialize();
    expect(result.ok).toBe(true);
    expect(model.isInitialized).toBe(true);
  }, 120_000);

  test("embed() returns 384-dim vector", async () => {
    const model = new EmbeddingModel(createSilentLogger());
    await model.initialize();

    const result = await model.embed("Hello world", "query");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toBeInstanceOf(Float32Array);
    expect(result.value.length).toBe(384);

    // Check that the vector is normalized (L2 norm ≈ 1.0)
    let norm = 0;
    for (const v of result.value) {
      norm += v * v;
    }
    expect(Math.abs(Math.sqrt(norm) - 1.0)).toBeLessThan(0.01);
  }, 120_000);

  test("similar texts have high cosine similarity", async () => {
    const model = new EmbeddingModel(createSilentLogger());
    await model.initialize();

    const r1 = await model.embed("TypeScript is a programming language", "query");
    const r2 = await model.embed("TypeScript is a typed superset of JavaScript", "query");
    const r3 = await model.embed("The weather is sunny today", "query");

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    if (!r1.ok || !r2.ok || !r3.ok) return;

    const simSimilar = EmbeddingModel.cosineSimilarity(r1.value, r2.value);
    const simDifferent = EmbeddingModel.cosineSimilarity(r1.value, r3.value);

    // Similar texts should have higher similarity than dissimilar ones
    expect(simSimilar).toBeGreaterThan(simDifferent);
    expect(simSimilar).toBeGreaterThan(0.5);
  }, 120_000);

  test("embedBatch() returns correct number of vectors", async () => {
    const model = new EmbeddingModel(createSilentLogger());
    await model.initialize();

    const texts = ["Hello world", "Bun runtime", "TypeScript types"];
    const result = await model.embedBatch(texts, "passage");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(3);
    for (const vec of result.value) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
    }
  }, 120_000);

  test("embedBatch() with empty array returns empty array", async () => {
    const model = new EmbeddingModel(createSilentLogger());
    await model.initialize();

    const result = await model.embedBatch([], "passage");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  }, 120_000);

  test("initialize() is idempotent", async () => {
    const model = new EmbeddingModel(createSilentLogger());
    const r1 = await model.initialize();
    const r2 = await model.initialize();
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  }, 120_000);
});
