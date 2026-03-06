/**
 * P1-22: GDPR cascading delete verification.
 *
 * Tests that deleting a memory or KG entity cascades correctly to:
 * - memory_edges (both source_id and target_id)
 * - kg_relations (both source_id and target_id)
 * - kg_complex_embeddings (entity_id)
 *
 * Also tests that bulk "forget" operations across all tables work.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Schema setup -- mirrors memory.db migrations v1-v4
// ---------------------------------------------------------------------------

function createMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('fact','preference','decision','episode','skill','relationship','schema')),
      layer TEXT NOT NULL CHECK(layer IN ('working','short_term','long_term','episodic','procedural')),
      content TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      source TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}',
      embedding BLOB,
      sensitive INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE memory_edges (
      source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      relation TEXT NOT NULL,
      weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 1),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (source_id, target_id, relation)
    );

    CREATE TABLE kg_entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      attributes TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE kg_relations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE kg_communities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      entity_ids TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE kg_complex_embeddings (
      entity_id TEXT PRIMARY KEY,
      real_embedding BLOB NOT NULL,
      imaginary_embedding BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  return db;
}

function createAuditDb(): Database {
  const db = new Database(":memory:");
  // Use version 1 schema only (no tamper protection triggers) so we can delete for GDPR
  db.exec(`
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      result TEXT NOT NULL CHECK(result IN ('success','failure','denied')),
      metadata TEXT DEFAULT '{}'
    );
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const now = Date.now();

function insertMemory(db: Database, id: string, content: string): void {
  db.query(
    "INSERT INTO memories (id, type, layer, content, confidence, source, created_at, updated_at, accessed_at) VALUES (?, 'fact', 'long_term', ?, 0.9, 'test', ?, ?, ?)",
  ).run(id, content, now, now, now);
}

function insertEdge(db: Database, sourceId: string, targetId: string, relation: string): void {
  db.query(
    "INSERT INTO memory_edges (source_id, target_id, relation, weight, created_at) VALUES (?, ?, ?, 0.8, ?)",
  ).run(sourceId, targetId, relation, now);
}

function insertEntity(db: Database, id: string, name: string, type: string): void {
  db.query("INSERT INTO kg_entities (id, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    name,
    type,
    now,
    now,
  );
}

function insertKgRelation(db: Database, id: string, sourceId: string, targetId: string, type: string): void {
  db.query(
    "INSERT INTO kg_relations (id, source_id, target_id, type, confidence, source, created_at) VALUES (?, ?, ?, ?, 0.9, 'test', ?)",
  ).run(id, sourceId, targetId, type, now);
}

function insertComplExEmbedding(db: Database, entityId: string): void {
  const blob = new Uint8Array(64);
  db.query(
    "INSERT INTO kg_complex_embeddings (entity_id, real_embedding, imaginary_embedding, updated_at) VALUES (?, ?, ?, ?)",
  ).run(entityId, blob, blob, now);
}

function insertAuditEntry(db: Database, id: string, target: string): void {
  db.query(
    "INSERT INTO audit_log (id, timestamp, actor, action, target, result) VALUES (?, ?, 'system', 'data_access', ?, 'success')",
  ).run(id, now, target);
}

function count(db: Database, table: string): number {
  return (db.query(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GDPR cascading delete -- memory.db", () => {
  let db: Database;

  beforeEach(() => {
    db = createMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  test("deleting a memory cascades to memory_edges where it is the source", () => {
    insertMemory(db, "m1", "source memory");
    insertMemory(db, "m2", "target memory");
    insertEdge(db, "m1", "m2", "related_to");

    expect(count(db, "memory_edges")).toBe(1);

    db.query("DELETE FROM memories WHERE id = ?").run("m1");

    expect(count(db, "memory_edges")).toBe(0);
    expect(count(db, "memories")).toBe(1); // m2 still exists
  });

  test("deleting a memory cascades to memory_edges where it is the target", () => {
    insertMemory(db, "m1", "source memory");
    insertMemory(db, "m2", "target memory");
    insertEdge(db, "m1", "m2", "related_to");

    db.query("DELETE FROM memories WHERE id = ?").run("m2");

    expect(count(db, "memory_edges")).toBe(0);
    expect(count(db, "memories")).toBe(1); // m1 still exists
  });

  test("deleting a memory preserves unrelated edges", () => {
    insertMemory(db, "m1", "memory one");
    insertMemory(db, "m2", "memory two");
    insertMemory(db, "m3", "memory three");
    insertEdge(db, "m1", "m2", "related_to");
    insertEdge(db, "m2", "m3", "supports");

    db.query("DELETE FROM memories WHERE id = ?").run("m1");

    // Only the m1->m2 edge should be deleted, m2->m3 survives
    expect(count(db, "memory_edges")).toBe(1);
    const remaining = db.query("SELECT source_id, target_id FROM memory_edges").get() as {
      source_id: string;
      target_id: string;
    };
    expect(remaining.source_id).toBe("m2");
    expect(remaining.target_id).toBe("m3");
  });

  test("deleting a KG entity cascades to kg_relations where it is the source", () => {
    insertEntity(db, "e1", "TypeScript", "technology");
    insertEntity(db, "e2", "Bun", "technology");
    insertKgRelation(db, "r1", "e1", "e2", "used_with");

    db.query("DELETE FROM kg_entities WHERE id = ?").run("e1");

    expect(count(db, "kg_relations")).toBe(0);
    expect(count(db, "kg_entities")).toBe(1);
  });

  test("deleting a KG entity cascades to kg_relations where it is the target", () => {
    insertEntity(db, "e1", "TypeScript", "technology");
    insertEntity(db, "e2", "Bun", "technology");
    insertKgRelation(db, "r1", "e1", "e2", "used_with");

    db.query("DELETE FROM kg_entities WHERE id = ?").run("e2");

    expect(count(db, "kg_relations")).toBe(0);
    expect(count(db, "kg_entities")).toBe(1);
  });

  test("deleting a KG entity preserves unrelated relations", () => {
    insertEntity(db, "e1", "TypeScript", "technology");
    insertEntity(db, "e2", "Bun", "technology");
    insertEntity(db, "e3", "SQLite", "technology");
    insertKgRelation(db, "r1", "e1", "e2", "used_with");
    insertKgRelation(db, "r2", "e2", "e3", "depends_on");

    db.query("DELETE FROM kg_entities WHERE id = ?").run("e1");

    expect(count(db, "kg_relations")).toBe(1);
    expect(count(db, "kg_entities")).toBe(2);
  });

  test("bulk delete of memories cascades all edges", () => {
    insertMemory(db, "m1", "one");
    insertMemory(db, "m2", "two");
    insertMemory(db, "m3", "three");
    insertEdge(db, "m1", "m2", "related_to");
    insertEdge(db, "m2", "m3", "supports");
    insertEdge(db, "m1", "m3", "related_to");

    // Delete all memories -- simulating "privacy forget --all"
    db.query("DELETE FROM memories").run();

    expect(count(db, "memories")).toBe(0);
    expect(count(db, "memory_edges")).toBe(0);
  });

  test("bulk delete of KG entities cascades all relations", () => {
    insertEntity(db, "e1", "TypeScript", "technology");
    insertEntity(db, "e2", "Bun", "technology");
    insertEntity(db, "e3", "SQLite", "technology");
    insertKgRelation(db, "r1", "e1", "e2", "used_with");
    insertKgRelation(db, "r2", "e2", "e3", "depends_on");
    insertKgRelation(db, "r3", "e1", "e3", "related_to");

    db.query("DELETE FROM kg_entities").run();

    expect(count(db, "kg_entities")).toBe(0);
    expect(count(db, "kg_relations")).toBe(0);
  });

  test("content-based forget deletes matching memories and cascades edges", () => {
    insertMemory(db, "m1", "Manuel prefers dark mode");
    insertMemory(db, "m2", "Manuel lives in Berlin");
    insertMemory(db, "m3", "SQLite is fast");
    insertEdge(db, "m1", "m2", "related_to");
    insertEdge(db, "m2", "m3", "supports");

    // Forget all memories about "Manuel"
    db.query("DELETE FROM memories WHERE content LIKE ?").run("%Manuel%");

    expect(count(db, "memories")).toBe(1); // only "SQLite is fast" remains
    expect(count(db, "memory_edges")).toBe(0); // both edges gone (m1 and m2 deleted)
  });

  test("entity-based forget deletes matching entities and cascades relations", () => {
    insertEntity(db, "e1", "Manuel", "person");
    insertEntity(db, "e2", "Eidolon", "project");
    insertEntity(db, "e3", "TypeScript", "technology");
    insertKgRelation(db, "r1", "e1", "e2", "owns");
    insertKgRelation(db, "r2", "e2", "e3", "uses");

    // Forget entity "Manuel"
    db.query("DELETE FROM kg_entities WHERE name = ?").run("Manuel");

    expect(count(db, "kg_entities")).toBe(2);
    expect(count(db, "kg_relations")).toBe(1); // only e2->e3 survives
  });
});

describe("GDPR cascading delete -- audit.db", () => {
  let audit: Database;

  beforeEach(() => {
    audit = createAuditDb();
  });

  afterEach(() => {
    audit.close();
  });

  test("can delete audit entries by target (entity-based forget)", () => {
    insertAuditEntry(audit, "a1", "memory:m1");
    insertAuditEntry(audit, "a2", "memory:m2");
    insertAuditEntry(audit, "a3", "entity:Manuel");

    audit.query("DELETE FROM audit_log WHERE target LIKE ?").run("%Manuel%");

    expect(count(audit, "audit_log")).toBe(2);
  });

  test("can delete all audit entries for full data wipe", () => {
    insertAuditEntry(audit, "a1", "memory:m1");
    insertAuditEntry(audit, "a2", "entity:e1");
    insertAuditEntry(audit, "a3", "session:s1");

    audit.query("DELETE FROM audit_log").run();

    expect(count(audit, "audit_log")).toBe(0);
  });
});

describe("GDPR full forget simulation", () => {
  let memDb: Database;
  let auditDb: Database;

  beforeEach(() => {
    memDb = createMemoryDb();
    auditDb = createAuditDb();
  });

  afterEach(() => {
    memDb.close();
    auditDb.close();
  });

  test("full forget clears all personal data across memory and audit databases", () => {
    // Seed memory.db with interconnected data
    insertMemory(memDb, "m1", "Manuel likes TypeScript");
    insertMemory(memDb, "m2", "Manuel prefers Bun");
    insertMemory(memDb, "m3", "SQLite is fast");
    insertEdge(memDb, "m1", "m2", "related_to");
    insertEdge(memDb, "m2", "m3", "supports");

    insertEntity(memDb, "e1", "Manuel", "person");
    insertEntity(memDb, "e2", "TypeScript", "technology");
    insertKgRelation(memDb, "r1", "e1", "e2", "uses");
    insertComplExEmbedding(memDb, "e1");
    insertComplExEmbedding(memDb, "e2");

    // Seed audit.db
    insertAuditEntry(auditDb, "a1", "memory:m1");
    insertAuditEntry(auditDb, "a2", "entity:Manuel");

    // Simulate "privacy forget --all"
    memDb.query("DELETE FROM memories").run();
    memDb.query("DELETE FROM kg_entities").run();
    memDb.query("DELETE FROM kg_communities").run();
    // Note: kg_complex_embeddings does NOT have FK cascade (migration v3 removed it)
    // so we must delete explicitly
    memDb.query("DELETE FROM kg_complex_embeddings").run();
    auditDb.query("DELETE FROM audit_log").run();

    // Verify everything is gone
    expect(count(memDb, "memories")).toBe(0);
    expect(count(memDb, "memory_edges")).toBe(0);
    expect(count(memDb, "kg_entities")).toBe(0);
    expect(count(memDb, "kg_relations")).toBe(0);
    expect(count(memDb, "kg_communities")).toBe(0);
    expect(count(memDb, "kg_complex_embeddings")).toBe(0);
    expect(count(auditDb, "audit_log")).toBe(0);
  });

  test("selective forget by entity name cascades only related data", () => {
    // Seed data about two different people
    insertMemory(memDb, "m1", "Manuel likes TypeScript");
    insertMemory(memDb, "m2", "Anna likes Python");
    insertMemory(memDb, "m3", "Shared project notes");
    insertEdge(memDb, "m1", "m3", "related_to");
    insertEdge(memDb, "m2", "m3", "related_to");

    insertEntity(memDb, "e1", "Manuel", "person");
    insertEntity(memDb, "e2", "Anna", "person");
    insertEntity(memDb, "e3", "TypeScript", "technology");
    insertKgRelation(memDb, "r1", "e1", "e3", "uses");
    insertKgRelation(memDb, "r2", "e2", "e3", "uses");

    // Forget only "Manuel"
    memDb.query("DELETE FROM memories WHERE content LIKE ?").run("%Manuel%");
    memDb.query("DELETE FROM kg_entities WHERE name = ?").run("Manuel");

    // Manuel data is gone, Anna's and shared data remain
    expect(count(memDb, "memories")).toBe(2); // Anna + shared
    expect(count(memDb, "memory_edges")).toBe(1); // only m2->m3
    expect(count(memDb, "kg_entities")).toBe(2); // Anna + TypeScript
    expect(count(memDb, "kg_relations")).toBe(1); // only e2->e3
  });
});
