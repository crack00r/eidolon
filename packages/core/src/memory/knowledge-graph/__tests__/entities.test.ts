import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../../database/schemas/memory.ts";
import type { Logger } from "../../../logging/logger.ts";
import { KGEntityStore } from "../entities.ts";
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("KGEntityStore", () => {
  let db: Database;
  let store: KGEntityStore;

  beforeEach(() => {
    db = createTestDb();
    store = new KGEntityStore(db, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  // -- create ---------------------------------------------------------------

  test("create() stores entity and returns it", () => {
    const result = store.create({ name: "TypeScript", type: "technology" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const entity = result.value;
    expect(entity.id).toBeDefined();
    expect(entity.name).toBe("TypeScript");
    expect(entity.type).toBe("technology");
    expect(entity.attributes).toEqual({});
    expect(entity.createdAt).toBeGreaterThan(0);
  });

  test("create() generates unique IDs", () => {
    const r1 = store.create({ name: "TypeScript", type: "technology" });
    const r2 = store.create({ name: "Bun", type: "technology" });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;

    expect(r1.value.id).not.toBe(r2.value.id);
  });

  // -- get ------------------------------------------------------------------

  test("get() returns entity by ID", () => {
    const created = store.create({ name: "TypeScript", type: "technology" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = store.get(created.value.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toBeNull();
    if (!result.value) return;
    expect(result.value.id).toBe(created.value.id);
    expect(result.value.name).toBe("TypeScript");
  });

  test("get() returns null for unknown ID", () => {
    const result = store.get("nonexistent-id");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  // -- findByName -----------------------------------------------------------

  test("findByName() finds case-insensitive", () => {
    store.create({ name: "TypeScript", type: "technology" });

    const result = store.findByName("typescript");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toBeNull();
    if (!result.value) return;
    expect(result.value.name).toBe("TypeScript");
  });

  // -- findByType -----------------------------------------------------------

  test("findByType() filters by type", () => {
    store.create({ name: "TypeScript", type: "technology" });
    store.create({ name: "Bun", type: "technology" });
    store.create({ name: "Manuel", type: "person" });

    const result = store.findByType("technology");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    expect(result.value.every((e) => e.type === "technology")).toBe(true);
  });

  // -- update ---------------------------------------------------------------

  test("update() modifies entity", () => {
    const created = store.create({ name: "TS", type: "technology" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = store.update(created.value.id, {
      name: "TypeScript",
      attributes: { version: "5.0" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe("TypeScript");
    expect(result.value.attributes).toEqual({ version: "5.0" });
  });

  // -- delete ---------------------------------------------------------------

  test("delete() removes entity", () => {
    const created = store.create({ name: "TypeScript", type: "technology" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const delResult = store.delete(created.value.id);
    expect(delResult.ok).toBe(true);

    const getResult = store.get(created.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value).toBeNull();
  });

  // -- findOrCreate ---------------------------------------------------------

  test("findOrCreate() returns existing entity", () => {
    const created = store.create({ name: "TypeScript", type: "technology" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = store.findOrCreate({ name: "typescript", type: "technology" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toBe(false);
    expect(result.value.entity.id).toBe(created.value.id);
  });

  test("findOrCreate() creates new entity", () => {
    const result = store.findOrCreate({ name: "Bun", type: "technology" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toBe(true);
    expect(result.value.entity.name).toBe("Bun");
  });

  // -- searchByName ---------------------------------------------------------

  test("searchByName() finds by prefix", () => {
    store.create({ name: "TypeScript", type: "technology" });
    store.create({ name: "Tailscale", type: "technology" });
    store.create({ name: "Bun", type: "technology" });

    const result = store.searchByName("T");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    const names = result.value.map((e) => e.name);
    expect(names).toContain("TypeScript");
    expect(names).toContain("Tailscale");
  });

  // -- merge ----------------------------------------------------------------

  test("merge() moves relations and deletes source", () => {
    const logger = createSilentLogger();
    const relations = new KGRelationStore(db, logger);

    const r1 = store.create({ name: "TS", type: "technology" });
    const r2 = store.create({ name: "TypeScript", type: "technology" });
    const r3 = store.create({ name: "Bun", type: "technology" });
    expect(r1.ok && r2.ok && r3.ok).toBe(true);
    if (!r1.ok || !r2.ok || !r3.ok) return;

    const sourceId = r1.value.id;
    const targetId = r2.value.id;
    const otherId = r3.value.id;

    // Create relations involving sourceId
    relations.create({ sourceId, targetId: otherId, type: "uses", source: "test" });
    relations.create({ sourceId: otherId, targetId: sourceId, type: "depends_on", source: "test" });

    // Merge source into target
    const mergeResult = store.merge(sourceId, targetId);
    expect(mergeResult.ok).toBe(true);

    // Source entity should be deleted
    const sourceGet = store.get(sourceId);
    expect(sourceGet.ok).toBe(true);
    if (!sourceGet.ok) return;
    expect(sourceGet.value).toBeNull();

    // Relations should now point to target
    const outgoing = relations.findBySubject(targetId);
    expect(outgoing.ok).toBe(true);
    if (!outgoing.ok) return;
    expect(outgoing.value.some((r) => r.targetId === otherId && r.type === "uses")).toBe(true);

    const incoming = relations.findByObject(targetId);
    expect(incoming.ok).toBe(true);
    if (!incoming.ok) return;
    expect(incoming.value.some((r) => r.sourceId === otherId && r.type === "depends_on")).toBe(true);
  });
});
