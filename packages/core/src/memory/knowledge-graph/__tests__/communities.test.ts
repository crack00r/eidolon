import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../../database/schemas/memory.ts";
import type { Logger } from "../../../logging/logger.ts";
import { CommunityDetector } from "../communities.ts";
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

function createEntity(
  store: KGEntityStore,
  name: string,
  type: "technology" | "person" | "concept" = "technology",
): string {
  const result = store.create({ name, type });
  if (!result.ok) throw new Error(`Failed to create entity: ${name}`);
  return result.value.id;
}

function createRelation(
  store: KGRelationStore,
  sourceId: string,
  targetId: string,
  type: "uses" | "depends_on" | "related_to" | "runs_on" = "related_to",
): string {
  const result = store.create({ sourceId, targetId, type, source: "test" });
  if (!result.ok) throw new Error("Failed to create relation");
  return result.value.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CommunityDetector", () => {
  let db: Database;
  let entityStore: KGEntityStore;
  let relationStore: KGRelationStore;
  let detector: CommunityDetector;

  beforeEach(() => {
    const logger = createSilentLogger();
    db = createTestDb();
    entityStore = new KGEntityStore(db, logger);
    relationStore = new KGRelationStore(db, logger);
    detector = new CommunityDetector(db, logger);
  });

  afterEach(() => {
    db.close();
  });

  // -- detectCommunities: empty graph --------------------------------------

  test("detectCommunities() returns empty array on empty graph", () => {
    const result = detector.detectCommunities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  // -- detectCommunities: single edge, one community ----------------------

  test("detectCommunities() returns one community for a single edge", () => {
    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    createRelation(relationStore, a, b);

    const result = detector.detectCommunities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBe(1);
    const community = result.value[0];
    if (!community) return;

    expect(community.entityIds).toHaveLength(2);
    expect(community.entityIds).toContain(a);
    expect(community.entityIds).toContain(b);
    expect(community.id).toBeDefined();
    expect(community.name).toBeDefined();
    expect(community.createdAt).toBeGreaterThan(0);
  });

  // -- detectCommunities: two separate clusters ----------------------------

  test("detectCommunities() separates disconnected clusters", () => {
    // Cluster 1: A-B-C (tightly connected)
    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    const c = createEntity(entityStore, "C");
    createRelation(relationStore, a, b);
    createRelation(relationStore, b, c);
    createRelation(relationStore, a, c);

    // Cluster 2: D-E-F (tightly connected)
    const d = createEntity(entityStore, "D");
    const e = createEntity(entityStore, "E");
    const f = createEntity(entityStore, "F");
    createRelation(relationStore, d, e);
    createRelation(relationStore, e, f);
    createRelation(relationStore, d, f);

    const result = detector.detectCommunities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBe(2);

    // Each community should have exactly 3 members
    const sizes = result.value.map((c) => c.entityIds.length).sort();
    expect(sizes).toEqual([3, 3]);

    // Verify cluster membership: all of {a,b,c} in one, all of {d,e,f} in the other
    const comm0Ids = new Set(result.value[0]?.entityIds ?? []);
    const comm1Ids = new Set(result.value[1]?.entityIds ?? []);

    const cluster1InComm0 = [a, b, c].every((id) => comm0Ids.has(id));
    const cluster1InComm1 = [a, b, c].every((id) => comm1Ids.has(id));
    expect(cluster1InComm0 || cluster1InComm1).toBe(true);

    const cluster2InComm0 = [d, e, f].every((id) => comm0Ids.has(id));
    const cluster2InComm1 = [d, e, f].every((id) => comm1Ids.has(id));
    expect(cluster2InComm0 || cluster2InComm1).toBe(true);
  });

  // -- detectCommunities: singletons are excluded -------------------------

  test("detectCommunities() excludes singleton communities", () => {
    // Only one entity with no relations
    createEntity(entityStore, "Lonely");

    const result = detector.detectCommunities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  // -- detectCommunities: isolated node with a connected pair -------------

  test("detectCommunities() isolates unrelated nodes", () => {
    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    createEntity(entityStore, "Isolated"); // no relations
    createRelation(relationStore, a, b);

    const result = detector.detectCommunities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only the A-B pair should form a community
    expect(result.value.length).toBe(1);
    const community = result.value[0];
    if (!community) return;
    expect(community.entityIds).toHaveLength(2);
  });

  // -- detectCommunities: self-loops are ignored --------------------------

  test("detectCommunities() ignores self-loops", () => {
    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    // Insert self-loop directly since the relation store validates FK but not self-loop
    const now = Date.now();
    db.query(
      `INSERT INTO kg_relations (id, source_id, target_id, type, confidence, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("self-loop-id", a, a, "related_to", 1.0, "test", now);

    createRelation(relationStore, a, b);

    const result = detector.detectCommunities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBe(1);
    const community = result.value[0];
    if (!community) return;
    expect(community.entityIds).toHaveLength(2);
  });

  // -- detectCommunities: clears previous communities ---------------------

  test("detectCommunities() clears previous communities on re-run", () => {
    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    createRelation(relationStore, a, b);

    // First run
    const r1 = detector.detectCommunities();
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.length).toBe(1);

    // Second run should replace, not append
    const r2 = detector.detectCommunities();
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.length).toBe(1);

    // Only 1 community in the DB
    const allResult = detector.getCommunities();
    expect(allResult.ok).toBe(true);
    if (!allResult.ok) return;
    expect(allResult.value.length).toBe(1);
  });

  // -- detectCommunities: resolution parameter ----------------------------

  test("higher resolution produces more communities", () => {
    // Create a connected graph where resolution matters
    // Chain: A-B-C-D-E with weaker links between B-C and D-E
    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    const c = createEntity(entityStore, "C");
    const d = createEntity(entityStore, "D");
    const e = createEntity(entityStore, "E");

    // Strong intra-cluster links
    createRelation(relationStore, a, b, "uses");
    createRelation(relationStore, b, a, "depends_on");
    createRelation(relationStore, d, e, "uses");
    createRelation(relationStore, e, d, "depends_on");

    // Weak inter-cluster link
    createRelation(relationStore, c, b, "related_to");
    createRelation(relationStore, c, d, "related_to");

    const logger = createSilentLogger();
    const lowRes = new CommunityDetector(db, logger, { resolution: 0.5 });
    const highRes = new CommunityDetector(db, logger, { resolution: 3.0 });

    const lowResult = lowRes.detectCommunities();
    const highResult = highRes.detectCommunities();

    expect(lowResult.ok).toBe(true);
    expect(highResult.ok).toBe(true);
    if (!lowResult.ok || !highResult.ok) return;

    // Higher resolution should produce at least as many communities
    expect(highResult.value.length).toBeGreaterThanOrEqual(lowResult.value.length);
  });

  // -- getCommunity -------------------------------------------------------

  test("getCommunity() returns null for unknown ID", () => {
    const result = detector.getCommunity("nonexistent-id");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  test("getCommunity() returns a detected community", () => {
    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    createRelation(relationStore, a, b);

    const detectResult = detector.detectCommunities();
    expect(detectResult.ok).toBe(true);
    if (!detectResult.ok) return;

    const community = detectResult.value[0];
    if (!community) return;

    const getResult = detector.getCommunity(community.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value).not.toBeNull();
    if (!getResult.value) return;
    expect(getResult.value.id).toBe(community.id);
    expect(getResult.value.entityIds).toEqual(community.entityIds);
  });

  // -- getCommunities -----------------------------------------------------

  test("getCommunities() returns all detected communities", () => {
    // Two disconnected pairs
    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    const c = createEntity(entityStore, "C");
    const d = createEntity(entityStore, "D");
    createRelation(relationStore, a, b);
    createRelation(relationStore, c, d);

    detector.detectCommunities();

    const result = detector.getCommunities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(2);
  });

  // -- summarizeCommunity -------------------------------------------------

  test("summarizeCommunity() generates text summary", () => {
    const a = createEntity(entityStore, "TypeScript", "technology");
    const b = createEntity(entityStore, "Bun", "technology");
    createRelation(relationStore, a, b, "runs_on");

    const detectResult = detector.detectCommunities();
    expect(detectResult.ok).toBe(true);
    if (!detectResult.ok) return;

    const community = detectResult.value[0];
    if (!community) return;

    const summaryResult = detector.summarizeCommunity(community.id);
    expect(summaryResult.ok).toBe(true);
    if (!summaryResult.ok) return;

    const summary = summaryResult.value;
    expect(summary).toContain("TypeScript");
    expect(summary).toContain("Bun");
    expect(summary).toContain("technology");
    expect(summary).toContain("runs_on");
  });

  test("summarizeCommunity() returns error for unknown community", () => {
    const result = detector.summarizeCommunity("nonexistent-id");
    expect(result.ok).toBe(false);
  });

  test("summarizeCommunity() updates stored summary", () => {
    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    createRelation(relationStore, a, b);

    const detectResult = detector.detectCommunities();
    expect(detectResult.ok).toBe(true);
    if (!detectResult.ok) return;

    const community = detectResult.value[0];
    if (!community) return;

    // Summary should be generic after detection
    expect(community.summary).toContain("related entities");

    // After summarize, DB should be updated
    detector.summarizeCommunity(community.id);

    const getResult = detector.getCommunity(community.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value).not.toBeNull();
    if (!getResult.value) return;
    expect(getResult.value.summary).toContain("A");
    expect(getResult.value.summary).toContain("B");
  });

  // -- KGCommunity shape --------------------------------------------------

  test("detected communities have correct KGCommunity shape", () => {
    const a = createEntity(entityStore, "X");
    const b = createEntity(entityStore, "Y");
    createRelation(relationStore, a, b);

    const result = detector.detectCommunities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const community = result.value[0];
    if (!community) return;

    expect(typeof community.id).toBe("string");
    expect(typeof community.name).toBe("string");
    expect(Array.isArray(community.entityIds)).toBe(true);
    expect(typeof community.summary).toBe("string");
    expect(typeof community.createdAt).toBe("number");
  });

  // -- maxIterations option -----------------------------------------------

  test("maxIterations limits iteration count", () => {
    const logger = createSilentLogger();
    const limited = new CommunityDetector(db, logger, { maxIterations: 1 });

    const a = createEntity(entityStore, "A");
    const b = createEntity(entityStore, "B");
    createRelation(relationStore, a, b);

    const result = limited.detectCommunities();
    expect(result.ok).toBe(true);
  });

  // -- larger graph -------------------------------------------------------

  test("detectCommunities() handles larger connected graph", () => {
    // Create a graph with 10 nodes in 2 clusters of 5, weakly connected
    const cluster1: string[] = [];
    const cluster2: string[] = [];

    for (let i = 0; i < 5; i++) {
      cluster1.push(createEntity(entityStore, `C1_${i}`));
      cluster2.push(createEntity(entityStore, `C2_${i}`));
    }

    // Fully connect each cluster
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        createRelation(relationStore, cluster1[i] as string, cluster1[j] as string);
        createRelation(relationStore, cluster2[i] as string, cluster2[j] as string);
      }
    }

    // One weak inter-cluster link
    createRelation(relationStore, cluster1[0] as string, cluster2[0] as string);

    const result = detector.detectCommunities();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should detect 2 communities (or at most 3 depending on resolution)
    expect(result.value.length).toBeGreaterThanOrEqual(1);
    expect(result.value.length).toBeLessThanOrEqual(3);
  });
});
