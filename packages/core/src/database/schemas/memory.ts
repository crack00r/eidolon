/**
 * Memory database schema migrations.
 *
 * Tables: memories (+ FTS5), memory_edges, kg_entities, kg_relations,
 * kg_communities, kg_complex_embeddings.
 */

import type { Migration } from "@eidolon/protocol";

export const MEMORY_MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    name: "initial_memory_schema",
    database: "memory",
    up: `
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
        metadata TEXT DEFAULT '{}'
      );

      CREATE INDEX idx_memories_type ON memories(type);
      CREATE INDEX idx_memories_layer ON memories(layer);
      CREATE INDEX idx_memories_confidence ON memories(confidence);
      CREATE INDEX idx_memories_created_at ON memories(created_at);
      CREATE INDEX idx_memories_updated_at ON memories(updated_at);
      CREATE INDEX idx_memories_accessed_at ON memories(accessed_at);

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        content,
        tags,
        content=memories,
        content_rowid=rowid,
        tokenize='porter unicode61'
      );

      CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;
      CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
      END;
      CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
        INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
      END;

      CREATE TABLE memory_edges (
        source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        weight REAL NOT NULL CHECK(weight >= 0 AND weight <= 1),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (source_id, target_id, relation)
      );

      CREATE INDEX idx_edges_source ON memory_edges(source_id);
      CREATE INDEX idx_edges_target ON memory_edges(target_id);

      CREATE TABLE kg_entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        attributes TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX idx_kg_entities_type ON kg_entities(type);
      CREATE INDEX idx_kg_entities_name ON kg_entities(name);

      CREATE TABLE kg_relations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX idx_kg_relations_source ON kg_relations(source_id);
      CREATE INDEX idx_kg_relations_target ON kg_relations(target_id);
      CREATE INDEX idx_kg_relations_type ON kg_relations(type);

      CREATE TABLE kg_communities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        entity_ids TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE kg_complex_embeddings (
        entity_id TEXT PRIMARY KEY REFERENCES kg_entities(id) ON DELETE CASCADE,
        real_embedding BLOB NOT NULL,
        imaginary_embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
    down: `
      DROP TABLE IF EXISTS kg_complex_embeddings;
      DROP TABLE IF EXISTS kg_communities;
      DROP TABLE IF EXISTS kg_relations;
      DROP TABLE IF EXISTS kg_entities;
      DROP TABLE IF EXISTS memory_edges;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TABLE IF EXISTS memories_fts;
      DROP TABLE IF EXISTS memories;
    `,
  },
  {
    version: 2,
    name: "add_embedding_column",
    database: "memory",
    up: `
      ALTER TABLE memories ADD COLUMN embedding BLOB;
      CREATE INDEX idx_memories_has_embedding ON memories(id) WHERE embedding IS NOT NULL;
    `,
    down: `
      DROP INDEX IF EXISTS idx_memories_has_embedding;
      -- SQLite cannot drop columns in older versions; this migration is effectively one-way.
    `,
  },
  {
    version: 3,
    name: "fix_complex_fk_add_indexes",
    database: "memory",
    up: `
      -- Remove FK constraint from kg_complex_embeddings to allow predicate storage
      CREATE TABLE kg_complex_embeddings_new (
        entity_id TEXT PRIMARY KEY,
        real_embedding BLOB NOT NULL,
        imaginary_embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO kg_complex_embeddings_new SELECT * FROM kg_complex_embeddings;
      DROP TABLE kg_complex_embeddings;
      ALTER TABLE kg_complex_embeddings_new RENAME TO kg_complex_embeddings;

      -- Add unique index on kg_entities(name, type) to prevent duplicates
      CREATE UNIQUE INDEX IF NOT EXISTS idx_kg_entities_name_type ON kg_entities(LOWER(name), type);

      -- Add index on memories(source) for source-based queries
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
    `,
    down: `
      DROP INDEX IF EXISTS idx_memories_source;
      DROP INDEX IF EXISTS idx_kg_entities_name_type;

      CREATE TABLE kg_complex_embeddings_new (
        entity_id TEXT PRIMARY KEY REFERENCES kg_entities(id) ON DELETE CASCADE,
        real_embedding BLOB NOT NULL,
        imaginary_embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO kg_complex_embeddings_new SELECT * FROM kg_complex_embeddings;
      DROP TABLE kg_complex_embeddings;
      ALTER TABLE kg_complex_embeddings_new RENAME TO kg_complex_embeddings;
    `,
  },
];
