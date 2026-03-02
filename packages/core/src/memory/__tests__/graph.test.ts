import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import type { CreateEdgeInput } from "../graph.ts";
import { GraphMemory } from "../graph.ts";
import { MemoryStore } from "../store.ts";

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

/** Create a minimal memory row and return its ID. */
function createMemory(store: MemoryStore, label: string): string {
  const result = store.create({
    type: "fact",
    layer: "long_term",
    content: label,
    confidence: 0.9,
    source: "test",
  });
  if (!result.ok) throw new Error(`Failed to create memory: ${label}`);
  return result.value.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GraphMemory", () => {
  let db: Database;
  let store: MemoryStore;
  let graph: GraphMemory;
  let memA: string;
  let memB: string;
  let memC: string;
  let memD: string;

  beforeEach(() => {
    const logger = createSilentLogger();
    db = createTestDb();
    store = new MemoryStore(db, logger);
    graph = new GraphMemory(db, logger);

    // Create four memories to use as edge endpoints
    memA = createMemory(store, "Tailscale VPN setup");
    memB = createMemory(store, "GPU worker configuration");
    memC = createMemory(store, "Cloudflare Tunnel");
    memD = createMemory(store, "Docker containers");
  });

  afterEach(() => {
    db.close();
  });

  // -- createEdge -----------------------------------------------------------

  test("createEdge creates an edge between two memories", () => {
    const result = graph.createEdge({
      sourceId: memA,
      targetId: memB,
      relation: "related_to",
      weight: 0.8,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const edge = result.value;
    expect(edge.sourceId).toBe(memA);
    expect(edge.targetId).toBe(memB);
    expect(edge.relation).toBe("related_to");
    expect(edge.weight).toBe(0.8);
    expect(edge.createdAt).toBeGreaterThan(0);
  });

  test("createEdge upserts (updates weight on duplicate)", () => {
    const input: CreateEdgeInput = {
      sourceId: memA,
      targetId: memB,
      relation: "related_to",
      weight: 0.5,
    };

    const first = graph.createEdge(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.weight).toBe(0.5);

    // Upsert with new weight
    const second = graph.createEdge({ ...input, weight: 0.9 });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.weight).toBe(0.9);

    // Verify only one edge exists
    const countResult = graph.count();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(1);
  });

  test("createEdge defaults weight to 1.0", () => {
    const result = graph.createEdge({
      sourceId: memA,
      targetId: memB,
      relation: "depends_on",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.weight).toBe(1.0);
  });

  // -- getOutgoing ----------------------------------------------------------

  test("getOutgoing returns outgoing edges", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to" });
    graph.createEdge({ sourceId: memA, targetId: memC, relation: "depends_on" });
    graph.createEdge({ sourceId: memB, targetId: memA, relation: "refines" }); // incoming to A

    const result = graph.getOutgoing(memA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    expect(result.value.every((e) => e.sourceId === memA)).toBe(true);
  });

  // -- getIncoming ----------------------------------------------------------

  test("getIncoming returns incoming edges", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to" });
    graph.createEdge({ sourceId: memC, targetId: memB, relation: "depends_on" });
    graph.createEdge({ sourceId: memB, targetId: memA, relation: "refines" }); // outgoing from B

    const result = graph.getIncoming(memB);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
    expect(result.value.every((e) => e.targetId === memB)).toBe(true);
  });

  // -- getAll ---------------------------------------------------------------

  test("getAll returns both directions", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to" });
    graph.createEdge({ sourceId: memC, targetId: memA, relation: "depends_on" });
    graph.createEdge({ sourceId: memB, targetId: memC, relation: "refines" }); // unrelated to A

    const result = graph.getAll(memA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(2);
  });

  // -- deleteEdge -----------------------------------------------------------

  test("deleteEdge removes specific edge", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to" });
    graph.createEdge({ sourceId: memA, targetId: memC, relation: "depends_on" });

    const result = graph.deleteEdge(memA, memB, "related_to");
    expect(result.ok).toBe(true);

    const remaining = graph.getOutgoing(memA);
    expect(remaining.ok).toBe(true);
    if (!remaining.ok) return;
    expect(remaining.value).toHaveLength(1);
    expect(remaining.value[0]?.relation).toBe("depends_on");
  });

  // -- deleteAllForMemory ---------------------------------------------------

  test("deleteAllForMemory removes all edges for a memory", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to" });
    graph.createEdge({ sourceId: memC, targetId: memA, relation: "depends_on" });
    graph.createEdge({ sourceId: memB, targetId: memC, relation: "refines" }); // unrelated to A

    const result = graph.deleteAllForMemory(memA);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(2);

    // Only the B->C edge should remain
    const countResult = graph.count();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(1);
  });

  // -- graphWalk ------------------------------------------------------------

  test("graphWalk returns neighbors at depth 1", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to", weight: 0.8 });
    graph.createEdge({ sourceId: memA, targetId: memC, relation: "depends_on", weight: 0.6 });
    graph.createEdge({ sourceId: memC, targetId: memD, relation: "refines", weight: 1.0 }); // depth 2

    const result = graph.graphWalk([memA], 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.map((r) => r.memoryId);
    expect(ids).toContain(memB);
    expect(ids).toContain(memC);
    expect(ids).not.toContain(memD); // too far at depth 1
    expect(ids).not.toContain(memA); // seed excluded

    // Check weights: 1.0 * edge_weight * 0.5
    const bResult = result.value.find((r) => r.memoryId === memB);
    expect(bResult?.weight).toBeCloseTo(0.4); // 1.0 * 0.8 * 0.5
    const cResult = result.value.find((r) => r.memoryId === memC);
    expect(cResult?.weight).toBeCloseTo(0.3); // 1.0 * 0.6 * 0.5
  });

  test("graphWalk returns neighbors at depth 2", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to", weight: 1.0 });
    graph.createEdge({ sourceId: memB, targetId: memC, relation: "depends_on", weight: 1.0 });
    graph.createEdge({ sourceId: memC, targetId: memD, relation: "refines", weight: 1.0 }); // depth 3

    const result = graph.graphWalk([memA], 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.map((r) => r.memoryId);
    expect(ids).toContain(memB);
    expect(ids).toContain(memC);
    expect(ids).not.toContain(memD); // depth 3, out of range
    expect(ids).not.toContain(memA); // seed excluded

    // Depth 1: 1.0 * 1.0 * 0.5 = 0.5
    const bResult = result.value.find((r) => r.memoryId === memB);
    expect(bResult?.weight).toBeCloseTo(0.5);

    // Depth 2: 0.5 * 1.0 * 0.5 = 0.25
    const cResult = result.value.find((r) => r.memoryId === memC);
    expect(cResult?.weight).toBeCloseTo(0.25);
  });

  test("graphWalk excludes seed IDs from results", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to", weight: 1.0 });

    const result = graph.graphWalk([memA], 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.value.map((r) => r.memoryId);
    expect(ids).not.toContain(memA);
    expect(ids).toContain(memB);
  });

  test("graphWalk returns empty array when no edges exist", () => {
    const result = graph.graphWalk([memA], 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  // -- strengthenEdge -------------------------------------------------------

  test("strengthenEdge increases weight capped at 1.0", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to", weight: 0.7 });

    // Strengthen by 0.2 -> 0.9
    let result = graph.strengthenEdge(memA, memB, "related_to", 0.2);
    expect(result.ok).toBe(true);

    let edges = graph.getOutgoing(memA);
    expect(edges.ok).toBe(true);
    if (!edges.ok) return;
    expect(edges.value[0]?.weight).toBeCloseTo(0.9);

    // Strengthen by 0.5 -> capped at 1.0
    result = graph.strengthenEdge(memA, memB, "related_to", 0.5);
    expect(result.ok).toBe(true);

    edges = graph.getOutgoing(memA);
    expect(edges.ok).toBe(true);
    if (!edges.ok) return;
    expect(edges.value[0]?.weight).toBe(1.0);
  });

  // -- decayWeights ---------------------------------------------------------

  test("decayWeights reduces all weights and removes tiny edges", () => {
    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to", weight: 1.0 });
    graph.createEdge({ sourceId: memA, targetId: memC, relation: "depends_on", weight: 0.02 });
    graph.createEdge({ sourceId: memB, targetId: memC, relation: "refines", weight: 0.5 });

    // Decay by 0.5 -> weights become: 0.5, 0.01, 0.25
    // The 0.01 edge (was 0.02) should survive (0.02 * 0.5 = 0.01 which is >= 0.01)
    const result = graph.decayWeights(0.5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify surviving edges have decayed weights
    const abEdges = graph.getOutgoing(memA);
    expect(abEdges.ok).toBe(true);
    if (!abEdges.ok) return;

    const abEdge = abEdges.value.find((e) => e.targetId === memB);
    expect(abEdge?.weight).toBeCloseTo(0.5);

    // Decay again by 0.3 -> weights become: 0.15, 0.003, 0.075
    // The 0.01 edge becomes 0.003 < 0.01, so it should be deleted
    const result2 = graph.decayWeights(0.3);
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;

    const countResult = graph.count();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(2); // Only the two larger edges survive
  });

  // -- count ----------------------------------------------------------------

  test("count returns total edge count", () => {
    const emptyCount = graph.count();
    expect(emptyCount.ok).toBe(true);
    if (!emptyCount.ok) return;
    expect(emptyCount.value).toBe(0);

    graph.createEdge({ sourceId: memA, targetId: memB, relation: "related_to" });
    graph.createEdge({ sourceId: memB, targetId: memC, relation: "depends_on" });
    graph.createEdge({ sourceId: memC, targetId: memD, relation: "refines" });

    const result = graph.count();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(3);
  });
});
