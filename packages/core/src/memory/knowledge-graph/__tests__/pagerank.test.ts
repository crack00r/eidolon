import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../../database/schemas/memory.ts";
import type { Logger } from "../../../logging/logger.ts";
import { KGEntityStore } from "../entities.ts";
import { computePageRank } from "../pagerank.ts";
import { KGRelationStore } from "../relations.ts";

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

function getImportance(db: Database, entityId: string): number {
  const row = db.query("SELECT importance FROM kg_entities WHERE id = ?").get(entityId) as {
    importance: number;
  } | null;
  if (!row) throw new Error(`Entity ${entityId} not found`);
  return row.importance;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computePageRank", () => {
  let db: Database;
  let entities: KGEntityStore;
  let relations: KGRelationStore;
  const logger = createSilentLogger();

  beforeEach(() => {
    db = createTestDb();
    entities = new KGEntityStore(db, logger);
    relations = new KGRelationStore(db, logger);
  });

  afterEach(() => {
    db.close();
  });

  test("returns zero counts for empty graph", () => {
    const result = computePageRank(db, logger);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.entityCount).toBe(0);
    expect(result.value.relationCount).toBe(0);
    expect(result.value.iterations).toBe(0);
    expect(result.value.converged).toBe(true);
  });

  test("assigns uniform rank to disconnected entities", () => {
    const a = entities.create({ name: "A", type: "concept" });
    const b = entities.create({ name: "B", type: "concept" });
    const c = entities.create({ name: "C", type: "concept" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("setup failed");

    const result = computePageRank(db, logger);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.entityCount).toBe(3);
    expect(result.value.relationCount).toBe(0);

    // With no edges and dangling node handling, all nodes should have equal rank
    const rankA = getImportance(db, a.value.id);
    const rankB = getImportance(db, b.value.id);
    const rankC = getImportance(db, c.value.id);

    expect(rankA).toBeCloseTo(1 / 3, 4);
    expect(rankB).toBeCloseTo(1 / 3, 4);
    expect(rankC).toBeCloseTo(1 / 3, 4);
  });

  test("hub node receives higher rank than leaf nodes", () => {
    // Create a star graph: B -> A, C -> A, D -> A
    // A should have the highest PageRank
    const a = entities.create({ name: "Hub", type: "concept" });
    const b = entities.create({ name: "Leaf1", type: "concept" });
    const c = entities.create({ name: "Leaf2", type: "concept" });
    const d = entities.create({ name: "Leaf3", type: "concept" });
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error("setup failed");

    relations.create({ sourceId: b.value.id, targetId: a.value.id, type: "related_to", source: "test" });
    relations.create({ sourceId: c.value.id, targetId: a.value.id, type: "related_to", source: "test" });
    relations.create({ sourceId: d.value.id, targetId: a.value.id, type: "related_to", source: "test" });

    const result = computePageRank(db, logger);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.entityCount).toBe(4);
    expect(result.value.relationCount).toBe(3);

    const rankHub = getImportance(db, a.value.id);
    const rankLeaf1 = getImportance(db, b.value.id);
    const rankLeaf2 = getImportance(db, c.value.id);
    const rankLeaf3 = getImportance(db, d.value.id);

    // Hub should have significantly higher rank than any leaf
    expect(rankHub).toBeGreaterThan(rankLeaf1);
    expect(rankHub).toBeGreaterThan(rankLeaf2);
    expect(rankHub).toBeGreaterThan(rankLeaf3);

    // All leaf nodes should have approximately equal rank
    expect(rankLeaf1).toBeCloseTo(rankLeaf2, 4);
    expect(rankLeaf2).toBeCloseTo(rankLeaf3, 4);

    // Sum of all ranks should be approximately 1
    const total = rankHub + rankLeaf1 + rankLeaf2 + rankLeaf3;
    expect(total).toBeCloseTo(1.0, 4);
  });

  test("chain graph: downstream nodes accumulate rank", () => {
    // A -> B -> C
    // C receives rank transitively through the chain
    const a = entities.create({ name: "Source", type: "concept" });
    const b = entities.create({ name: "Middle", type: "concept" });
    const c = entities.create({ name: "Sink", type: "concept" });
    if (!a.ok || !b.ok || !c.ok) throw new Error("setup failed");

    relations.create({ sourceId: a.value.id, targetId: b.value.id, type: "related_to", source: "test" });
    relations.create({ sourceId: b.value.id, targetId: c.value.id, type: "related_to", source: "test" });

    const result = computePageRank(db, logger);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rankA = getImportance(db, a.value.id);
    const rankB = getImportance(db, b.value.id);
    const rankC = getImportance(db, c.value.id);

    // C is the ultimate sink, should have highest rank
    // B receives from A and passes to C, so intermediate rank
    // A only receives from dangling redistribution
    expect(rankC).toBeGreaterThan(rankB);
    expect(rankB).toBeGreaterThan(rankA);
  });

  test("converges within max iterations for small graph", () => {
    const a = entities.create({ name: "A", type: "concept" });
    const b = entities.create({ name: "B", type: "concept" });
    if (!a.ok || !b.ok) throw new Error("setup failed");

    // Bidirectional link
    relations.create({ sourceId: a.value.id, targetId: b.value.id, type: "related_to", source: "test" });
    relations.create({ sourceId: b.value.id, targetId: a.value.id, type: "related_to", source: "test" });

    const result = computePageRank(db, logger, {
      maxIterations: 20,
      convergenceThreshold: 0.001,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.converged).toBe(true);
    expect(result.value.iterations).toBeLessThanOrEqual(20);

    // Symmetric graph: both nodes should have equal rank
    const rankA = getImportance(db, a.value.id);
    const rankB = getImportance(db, b.value.id);
    expect(rankA).toBeCloseTo(rankB, 4);
    expect(rankA).toBeCloseTo(0.5, 4);
  });

  test("respects custom damping factor", () => {
    const a = entities.create({ name: "A", type: "concept" });
    const b = entities.create({ name: "B", type: "concept" });
    if (!a.ok || !b.ok) throw new Error("setup failed");

    relations.create({ sourceId: a.value.id, targetId: b.value.id, type: "related_to", source: "test" });

    // With damping=0, all rank comes from teleportation (uniform)
    const result = computePageRank(db, logger, { dampingFactor: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rankA = getImportance(db, a.value.id);
    const rankB = getImportance(db, b.value.id);

    // d=0 means rank = 1/N for all nodes (pure teleportation)
    expect(rankA).toBeCloseTo(0.5, 4);
    expect(rankB).toBeCloseTo(0.5, 4);
  });
});
