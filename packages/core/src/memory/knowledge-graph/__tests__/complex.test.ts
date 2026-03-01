import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../database/migrations.js";
import { MEMORY_MIGRATIONS } from "../../../database/schemas/memory.js";
import type { Logger } from "../../../logging/logger.js";
import type { Triple } from "../complex.js";
import { ComplExEmbeddings } from "../complex.js";

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

/** Insert an entity into kg_entities so the FK constraint is satisfied. */
function insertKgEntity(db: Database, id: string, name: string, type: string): void {
  const now = Date.now();
  db.query(
    `INSERT INTO kg_entities (id, name, type, attributes, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?)`,
  ).run(id, name, type, now, now);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ComplExEmbeddings", () => {
  let db: Database;
  let complex: ComplExEmbeddings;

  beforeEach(() => {
    db = createTestDb();
    complex = new ComplExEmbeddings(db, createSilentLogger(), {
      dimensions: 8,
      epochs: 50,
      learningRate: 0.05,
      negativeRatio: 3,
    });
  });

  afterEach(() => {
    db.close();
  });

  // -- Static methods -------------------------------------------------------

  test("complexScore computes correct Hermitian dot product", () => {
    const hRe = new Float32Array([1, 0, 0]);
    const hIm = new Float32Array([0, 1, 0]);
    const rRe = new Float32Array([1, 1, 0]);
    const rIm = new Float32Array([0, 0, 1]);
    const tRe = new Float32Array([1, 0, 1]);
    const tIm = new Float32Array([0, 1, 0]);

    // Manual calculation for each dimension i:
    // i=0: hRe*rRe*tRe + hIm*rRe*tIm + hRe*rIm*tIm - hIm*rIm*tRe
    //      = 1*1*1 + 0*1*0 + 1*0*0 - 0*0*1 = 1
    // i=1: 0*1*0 + 1*1*1 + 0*0*1 - 1*0*0 = 1
    // i=2: 0*0*1 + 0*0*0 + 0*1*0 - 0*1*1 = 0
    // Total: 2
    const score = ComplExEmbeddings.complexScore(hRe, hIm, rRe, rIm, tRe, tIm);
    expect(score).toBeCloseTo(2, 5);
  });

  test("sigmoid returns correct values", () => {
    // Large positive -> close to 1
    expect(ComplExEmbeddings.sigmoid(10)).toBeCloseTo(1, 3);
    // Large negative -> close to 0
    expect(ComplExEmbeddings.sigmoid(-10)).toBeCloseTo(0, 3);
    // Moderate value
    expect(ComplExEmbeddings.sigmoid(1)).toBeCloseTo(0.7310585786, 5);
  });

  test("sigmoid(0) returns 0.5", () => {
    expect(ComplExEmbeddings.sigmoid(0)).toBe(0.5);
  });

  // -- Store / Get ----------------------------------------------------------

  test("storeEmbedding and getEmbedding roundtrip", () => {
    insertKgEntity(db, "test-entity", "TestEntity", "concept");

    const realPart = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const imagPart = new Float32Array([5.0, 6.0, 7.0, 8.0]);

    const storeResult = complex.storeEmbedding("test-entity", realPart, imagPart);
    expect(storeResult.ok).toBe(true);

    const getResult = complex.getEmbedding("test-entity");
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value).not.toBeNull();
    if (!getResult.value) return;

    expect(getResult.value.real.length).toBe(4);
    expect(getResult.value.imaginary.length).toBe(4);

    for (let i = 0; i < 4; i++) {
      expect(getResult.value.real[i]).toBeCloseTo(realPart[i] as number, 5);
      expect(getResult.value.imaginary[i]).toBeCloseTo(imagPart[i] as number, 5);
    }
  });

  test("getEmbedding returns null for unknown ID", () => {
    const result = complex.getEmbedding("nonexistent-id");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  // -- Training -------------------------------------------------------------

  test("train produces embeddings for all entities and predicates", () => {
    const entities = ["e1", "e2", "e3"];
    const predicates = ["uses", "depends_on"];

    // Insert entities and predicates into kg_entities for FK constraint
    for (const id of entities) {
      insertKgEntity(db, id, id, "thing");
    }
    for (const pred of predicates) {
      insertKgEntity(db, pred, pred, "relation");
    }

    const triples: Triple[] = [
      { subject: "e1", predicate: "uses", object: "e2" },
      { subject: "e2", predicate: "depends_on", object: "e3" },
    ];

    const result = complex.train(triples, entities);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.epochs).toBe(50);
    expect(typeof result.value.loss).toBe("number");
    expect(result.value.loss).toBeGreaterThanOrEqual(0);

    // Verify all entities have stored embeddings
    for (const id of entities) {
      const emb = complex.getEmbedding(id);
      expect(emb.ok).toBe(true);
      if (!emb.ok) return;
      expect(emb.value).not.toBeNull();
      if (!emb.value) return;
      expect(emb.value.real.length).toBe(8);
      expect(emb.value.imaginary.length).toBe(8);
    }

    // Verify all predicates have stored embeddings
    for (const pred of predicates) {
      const emb = complex.getEmbedding(pred);
      expect(emb.ok).toBe(true);
      if (!emb.ok) return;
      expect(emb.value).not.toBeNull();
    }
  });

  test("train positive triples score higher than random", () => {
    // Use more epochs and higher dimensionality for reliable separation
    const trained = new ComplExEmbeddings(db, createSilentLogger(), {
      dimensions: 32,
      epochs: 200,
      learningRate: 0.05,
      negativeRatio: 5,
    });

    const entities = ["e1", "e2", "e3"];
    const predicates = ["uses", "depends_on"];

    for (const id of entities) {
      insertKgEntity(db, id, id, "thing");
    }
    for (const pred of predicates) {
      insertKgEntity(db, pred, pred, "relation");
    }

    const triples: Triple[] = [
      { subject: "e1", predicate: "uses", object: "e2" },
      { subject: "e2", predicate: "depends_on", object: "e3" },
    ];

    const trainResult = trained.train(triples, entities);
    expect(trainResult.ok).toBe(true);

    // Score the positive triple
    const posResult = trained.score("e1", "uses", "e2");
    expect(posResult.ok).toBe(true);
    if (!posResult.ok) return;

    // Score a negative triple (e3 uses e1 -- not in training data)
    const negResult = trained.score("e3", "uses", "e1");
    expect(negResult.ok).toBe(true);
    if (!negResult.ok) return;

    // Positive should score higher than random negative
    expect(posResult.value).toBeGreaterThan(negResult.value);
  });

  test("predictLinks returns scored predictions", () => {
    const entities = ["e1", "e2", "e3"];
    const predicates = ["uses", "depends_on"];

    for (const id of entities) {
      insertKgEntity(db, id, id, "thing");
    }
    for (const pred of predicates) {
      insertKgEntity(db, pred, pred, "relation");
    }

    const triples: Triple[] = [
      { subject: "e1", predicate: "uses", object: "e2" },
      { subject: "e2", predicate: "depends_on", object: "e3" },
    ];

    const trainResult = complex.train(triples, entities);
    expect(trainResult.ok).toBe(true);

    const predictResult = complex.predictLinks("e1", predicates, entities, 5);
    expect(predictResult.ok).toBe(true);
    if (!predictResult.ok) return;

    const predictions = predictResult.value;
    expect(predictions.length).toBeGreaterThan(0);
    expect(predictions.length).toBeLessThanOrEqual(5);

    // All predictions should have the correct shape
    for (const pred of predictions) {
      expect(pred.subject).toBe("e1");
      expect(predicates).toContain(pred.predicate);
      expect(pred.object).not.toBe("e1"); // should not predict self-links
      expect(typeof pred.score).toBe("number");
      expect(pred.source).toBe("prediction");
    }

    // Predictions should be sorted by score descending
    for (let i = 1; i < predictions.length; i++) {
      const prev = predictions[i - 1] as { score: number };
      const curr = predictions[i] as { score: number };
      expect(prev.score).toBeGreaterThanOrEqual(curr.score);
    }
  });
});
