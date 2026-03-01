import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../database/migrations.js";
import { MEMORY_MIGRATIONS } from "../../../database/schemas/memory.js";
import type { Logger } from "../../../logging/logger.js";
import { KGEntityStore } from "../entities.js";
import { KGRelationStore } from "../relations.js";

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

/** Create an entity and return its ID. */
function createEntity(store: KGEntityStore, name: string, type: "technology" | "person" = "technology"): string {
  const result = store.create({ name, type });
  if (!result.ok) throw new Error(`Failed to create entity: ${name}`);
  return result.value.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KGRelationStore", () => {
  let db: Database;
  let entityStore: KGEntityStore;
  let store: KGRelationStore;
  let entityA: string;
  let entityB: string;
  let entityC: string;

  beforeEach(() => {
    const logger = createSilentLogger();
    db = createTestDb();
    entityStore = new KGEntityStore(db, logger);
    store = new KGRelationStore(db, logger);

    entityA = createEntity(entityStore, "TypeScript");
    entityB = createEntity(entityStore, "Bun");
    entityC = createEntity(entityStore, "Manuel", "person");
  });

  afterEach(() => {
    db.close();
  });

  // -- create ---------------------------------------------------------------

  test("create() stores relation", () => {
    const result = store.create({
      sourceId: entityA,
      targetId: entityB,
      type: "runs_on",
      source: "extraction",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rel = result.value;
    expect(rel.id).toBeDefined();
    expect(rel.sourceId).toBe(entityA);
    expect(rel.targetId).toBe(entityB);
    expect(rel.type).toBe("runs_on");
    expect(rel.confidence).toBe(1.0);
    expect(rel.source).toBe("extraction");
    expect(rel.createdAt).toBeGreaterThan(0);
  });

  // -- findBySubject --------------------------------------------------------

  test("findBySubject() returns outgoing relations", () => {
    store.create({ sourceId: entityA, targetId: entityB, type: "runs_on", source: "extraction" });
    store.create({ sourceId: entityA, targetId: entityC, type: "uses", source: "extraction" });
    store.create({ sourceId: entityB, targetId: entityA, type: "depends_on", source: "extraction" });

    const result = store.findBySubject(entityA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    expect(result.value.every((r) => r.sourceId === entityA)).toBe(true);
  });

  // -- findByObject ---------------------------------------------------------

  test("findByObject() returns incoming relations", () => {
    store.create({ sourceId: entityA, targetId: entityB, type: "runs_on", source: "extraction" });
    store.create({ sourceId: entityC, targetId: entityB, type: "uses", source: "extraction" });
    store.create({ sourceId: entityB, targetId: entityA, type: "depends_on", source: "extraction" });

    const result = store.findByObject(entityB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    expect(result.value.every((r) => r.targetId === entityB)).toBe(true);
  });

  // -- findByEntity ---------------------------------------------------------

  test("findByEntity() returns both directions", () => {
    store.create({ sourceId: entityA, targetId: entityB, type: "runs_on", source: "extraction" });
    store.create({ sourceId: entityC, targetId: entityA, type: "uses", source: "extraction" });
    store.create({ sourceId: entityB, targetId: entityC, type: "depends_on", source: "extraction" });

    const result = store.findByEntity(entityA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
  });

  // -- findTriple -----------------------------------------------------------

  test("findTriple() finds specific triple", () => {
    store.create({ sourceId: entityA, targetId: entityB, type: "runs_on", source: "extraction" });

    const result = store.findTriple(entityA, "runs_on", entityB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toBeNull();
    if (!result.value) return;
    expect(result.value.sourceId).toBe(entityA);
    expect(result.value.type).toBe("runs_on");
    expect(result.value.targetId).toBe(entityB);
  });

  test("findTriple() returns null when not found", () => {
    const result = store.findTriple(entityA, "runs_on", entityB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  // -- delete ---------------------------------------------------------------

  test("delete() removes relation", () => {
    const created = store.create({
      sourceId: entityA,
      targetId: entityB,
      type: "runs_on",
      source: "extraction",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const delResult = store.delete(created.value.id);
    expect(delResult.ok).toBe(true);

    const getResult = store.get(created.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value).toBeNull();
  });

  // -- deleteByEntity -------------------------------------------------------

  test("deleteByEntity() removes all relations", () => {
    store.create({ sourceId: entityA, targetId: entityB, type: "runs_on", source: "extraction" });
    store.create({ sourceId: entityC, targetId: entityA, type: "uses", source: "extraction" });
    store.create({ sourceId: entityB, targetId: entityC, type: "depends_on", source: "extraction" });

    const result = store.deleteByEntity(entityA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(2);

    // Only B->C should remain
    const countResult = store.count();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(1);
  });

  // -- updateConfidence -----------------------------------------------------

  test("updateConfidence() changes confidence", () => {
    const created = store.create({
      sourceId: entityA,
      targetId: entityB,
      type: "runs_on",
      confidence: 0.5,
      source: "extraction",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updateResult = store.updateConfidence(created.value.id, 0.9);
    expect(updateResult.ok).toBe(true);

    const getResult = store.get(created.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value).not.toBeNull();
    if (!getResult.value) return;
    expect(getResult.value.confidence).toBe(0.9);
  });

  // -- getAllTriples ---------------------------------------------------------

  test("getAllTriples() returns joined names", () => {
    store.create({ sourceId: entityA, targetId: entityB, type: "runs_on", source: "extraction" });
    store.create({ sourceId: entityC, targetId: entityA, type: "uses", confidence: 0.8, source: "manual" });

    const result = store.getAllTriples();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);

    const runsOn = result.value.find((t) => t.predicate === "runs_on");
    expect(runsOn).toBeDefined();
    if (!runsOn) return;
    expect(runsOn.subject).toBe("TypeScript");
    expect(runsOn.object).toBe("Bun");
    expect(runsOn.confidence).toBe(1.0);

    const uses = result.value.find((t) => t.predicate === "uses");
    expect(uses).toBeDefined();
    if (!uses) return;
    expect(uses.subject).toBe("Manuel");
    expect(uses.object).toBe("TypeScript");
    expect(uses.confidence).toBe(0.8);
  });
});
