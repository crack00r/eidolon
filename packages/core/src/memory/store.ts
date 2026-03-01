/**
 * MemoryStore -- CRUD operations on the `memories` table in memory.db.
 *
 * Provides create, read, update, delete, list, count, full-text search,
 * batch create, and housekeeping (prune) operations. All methods return
 * Result<T, EidolonError> for consistent error handling.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Memory, MemoryLayer, MemoryType, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateMemoryInput {
  readonly type: MemoryType;
  readonly layer: MemoryLayer;
  readonly content: string;
  readonly confidence: number;
  readonly source: string;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface UpdateMemoryInput {
  readonly content?: string;
  readonly confidence?: number;
  readonly layer?: MemoryLayer;
  readonly tags?: readonly string[];
  readonly metadata?: Record<string, unknown>;
}

export interface MemoryListOptions {
  readonly types?: readonly MemoryType[];
  readonly layers?: readonly MemoryLayer[];
  readonly minConfidence?: number;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderBy?: "created_at" | "updated_at" | "accessed_at" | "confidence";
  readonly order?: "asc" | "desc";
}

// ---------------------------------------------------------------------------
// Internal row shape from SQLite
// ---------------------------------------------------------------------------

interface MemoryRow {
  readonly id: string;
  readonly type: string;
  readonly layer: string;
  readonly content: string;
  readonly confidence: number;
  readonly source: string;
  readonly tags: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly accessed_at: number;
  readonly access_count: number;
  readonly metadata: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    type: row.type as MemoryType,
    layer: row.layer as MemoryLayer,
    content: row.content,
    confidence: row.confidence,
    source: row.source,
    tags: JSON.parse(row.tags) as string[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    accessedAt: row.accessed_at,
    accessCount: row.access_count,
    metadata: JSON.parse(row.metadata ?? "{}") as Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------
// MemoryStore
// ---------------------------------------------------------------------------

export class MemoryStore {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("memory-store");
  }

  /** Create a new memory. Generates a UUID as the ID. */
  create(input: CreateMemoryInput): Result<Memory, EidolonError> {
    try {
      const id = randomUUID();
      const now = Date.now();
      const tags = JSON.stringify(input.tags ?? []);
      const metadata = JSON.stringify(input.metadata ?? {});

      this.db
        .query(
          `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(id, input.type, input.layer, input.content, input.confidence, input.source, tags, now, now, now, metadata);

      const memory: Memory = {
        id,
        type: input.type,
        layer: input.layer,
        content: input.content,
        confidence: input.confidence,
        source: input.source,
        tags: input.tags ? [...input.tags] : [],
        createdAt: now,
        updatedAt: now,
        accessedAt: now,
        accessCount: 0,
        metadata: input.metadata ?? {},
      };

      this.logger.debug("create", `Created memory ${id}`, { type: input.type, layer: input.layer });
      return Ok(memory);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create memory", cause));
    }
  }

  /** Get a memory by ID. Also updates accessed_at and access_count (touch on read). */
  get(id: string): Result<Memory | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | null;

      if (!row) {
        return Ok(null);
      }

      // Touch: update accessed_at and increment access_count
      const now = Date.now();
      this.db.query("UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?").run(now, id);

      const memory = rowToMemory(row);
      return Ok({
        ...memory,
        accessedAt: now,
        accessCount: memory.accessCount + 1,
      });
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get memory ${id}`, cause));
    }
  }

  /** Update an existing memory. Returns the updated memory or error if not found. */
  update(id: string, input: UpdateMemoryInput): Result<Memory, EidolonError> {
    try {
      // Check existence first
      const existing = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | null;
      if (!existing) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Memory ${id} not found`));
      }

      const now = Date.now();
      const setClauses: string[] = ["updated_at = ?"];
      const params: Array<string | number> = [now];

      if (input.content !== undefined) {
        setClauses.push("content = ?");
        params.push(input.content);
      }
      if (input.confidence !== undefined) {
        setClauses.push("confidence = ?");
        params.push(input.confidence);
      }
      if (input.layer !== undefined) {
        setClauses.push("layer = ?");
        params.push(input.layer);
      }
      if (input.tags !== undefined) {
        setClauses.push("tags = ?");
        params.push(JSON.stringify(input.tags));
      }
      if (input.metadata !== undefined) {
        setClauses.push("metadata = ?");
        params.push(JSON.stringify(input.metadata));
      }

      params.push(id);
      this.db.query(`UPDATE memories SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

      // Re-read the updated row
      const updated = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow;
      return Ok(rowToMemory(updated));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update memory ${id}`, cause));
    }
  }

  /** Delete a memory by ID. */
  delete(id: string): Result<void, EidolonError> {
    try {
      const existing = this.db.query("SELECT 1 FROM memories WHERE id = ?").get(id);
      if (!existing) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Memory ${id} not found`));
      }
      this.db.query("DELETE FROM memories WHERE id = ?").run(id);
      this.logger.debug("delete", `Deleted memory ${id}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete memory ${id}`, cause));
    }
  }

  /** List memories with filtering and pagination. */
  list(options?: MemoryListOptions): Result<Memory[], EidolonError> {
    try {
      const whereClauses: string[] = [];
      const params: Array<string | number> = [];

      if (options?.types && options.types.length > 0) {
        const placeholders = options.types.map(() => "?").join(", ");
        whereClauses.push(`type IN (${placeholders})`);
        params.push(...options.types);
      }

      if (options?.layers && options.layers.length > 0) {
        const placeholders = options.layers.map(() => "?").join(", ");
        whereClauses.push(`layer IN (${placeholders})`);
        params.push(...options.layers);
      }

      if (options?.minConfidence !== undefined) {
        whereClauses.push("confidence >= ?");
        params.push(options.minConfidence);
      }

      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
      const orderBy = options?.orderBy ?? "created_at";
      const order = options?.order ?? "desc";
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;

      const sql = `SELECT * FROM memories ${where} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = this.db.query(sql).all(...params) as MemoryRow[];
      return Ok(rows.map(rowToMemory));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list memories", cause));
    }
  }

  /** Count memories matching optional type and layer filters. */
  count(types?: readonly MemoryType[], layers?: readonly MemoryLayer[]): Result<number, EidolonError> {
    try {
      const whereClauses: string[] = [];
      const params: Array<string | number> = [];

      if (types && types.length > 0) {
        const placeholders = types.map(() => "?").join(", ");
        whereClauses.push(`type IN (${placeholders})`);
        params.push(...types);
      }

      if (layers && layers.length > 0) {
        const placeholders = layers.map(() => "?").join(", ");
        whereClauses.push(`layer IN (${placeholders})`);
        params.push(...layers);
      }

      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
      const row = this.db.query(`SELECT COUNT(*) as count FROM memories ${where}`).get(...params) as {
        count: number;
      };

      return Ok(row.count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to count memories", cause));
    }
  }

  /** Full-text search via FTS5. Returns ranked results (higher rank = better). */
  searchText(query: string, limit?: number): Result<Array<{ memory: Memory; rank: number }>, EidolonError> {
    try {
      const maxResults = limit ?? 20;

      const rows = this.db
        .query(
          `SELECT m.*, f.rank
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ?
           ORDER BY f.rank
           LIMIT ?`,
        )
        .all(query, maxResults) as Array<MemoryRow & { rank: number }>;

      const results = rows.map((row) => ({
        memory: rowToMemory(row),
        rank: -row.rank, // FTS5 rank is negative; negate for positive score
      }));

      this.logger.debug("search", `FTS search for "${query}"`, { resultCount: results.length });
      return Ok(results);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Full-text search failed for query: ${query}`, cause));
    }
  }

  /** Delete short_term memories older than cutoffMs. Returns number of deleted rows. */
  pruneExpired(cutoffMs: number): Result<number, EidolonError> {
    try {
      // Count matching rows first (DELETE changes count is inflated by FTS triggers)
      const countRow = this.db
        .query("SELECT COUNT(*) as count FROM memories WHERE layer = 'short_term' AND created_at < ?")
        .get(cutoffMs) as { count: number };
      const count = countRow.count;

      if (count > 0) {
        this.db.query("DELETE FROM memories WHERE layer = 'short_term' AND created_at < ?").run(cutoffMs);
      }

      this.logger.debug("prune", `Pruned ${count} expired short_term memories`);
      return Ok(count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to prune expired memories", cause));
    }
  }

  /** Bulk create memories within a single transaction. */
  createBatch(inputs: readonly CreateMemoryInput[]): Result<Memory[], EidolonError> {
    try {
      const memories: Memory[] = [];

      const insertFn = this.db.transaction(() => {
        for (const input of inputs) {
          const id = randomUUID();
          const now = Date.now();
          const tags = JSON.stringify(input.tags ?? []);
          const metadata = JSON.stringify(input.metadata ?? {});

          this.db
            .query(
              `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            )
            .run(
              id,
              input.type,
              input.layer,
              input.content,
              input.confidence,
              input.source,
              tags,
              now,
              now,
              now,
              metadata,
            );

          memories.push({
            id,
            type: input.type,
            layer: input.layer,
            content: input.content,
            confidence: input.confidence,
            source: input.source,
            tags: input.tags ? [...input.tags] : [],
            createdAt: now,
            updatedAt: now,
            accessedAt: now,
            accessCount: 0,
            metadata: input.metadata ?? {},
          });
        }
      });

      insertFn();

      this.logger.debug("createBatch", `Created ${memories.length} memories in batch`);
      return Ok(memories);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create memory batch", cause));
    }
  }
}
