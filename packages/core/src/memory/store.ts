/**
 * MemoryStore -- CRUD operations on the `memories` table in memory.db.
 *
 * Provides create, read, update, delete, list, count, full-text search,
 * batch create, and housekeeping (prune) operations. All methods return
 * Result<T, EidolonError> for consistent error handling.
 *
 * SECURITY NOTE (DB-004): Memory content is stored in PLAINTEXT.
 * This is an accepted risk because:
 * 1. FTS5 full-text search requires cleartext content for indexing
 * 2. sqlite-vec vector search needs plaintext for embedding generation
 * 3. Encrypting content would break all search functionality
 * 4. The database file itself should be protected via filesystem permissions (0600)
 *
 * Memories containing PII should be flagged with `sensitive: true` so they can
 * receive special handling (GDPR deletion, export exclusion, future at-rest encryption).
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Memory, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { createMemoryBatch, findSimilarMemories } from "./store-batch.ts";
import type { CreateMemoryInput, MemoryListOptions, MemoryRow, UpdateMemoryInput } from "./store-helpers.ts";
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  MAX_CONTENT_LENGTH,
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  rowToMemory,
  VALID_MEMORY_LAYERS,
  VALID_MEMORY_TYPES,
} from "./store-helpers.ts";

// Re-export types for backward compatibility
export type { CreateMemoryInput, MemoryListOptions, UpdateMemoryInput } from "./store-helpers.ts";

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
    if (!VALID_MEMORY_TYPES.has(input.type)) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Invalid memory type: "${input.type}"`));
    }
    if (!VALID_MEMORY_LAYERS.has(input.layer)) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Invalid memory layer: "${input.layer}"`));
    }
    if (input.content.length > MAX_CONTENT_LENGTH) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Memory content exceeds maximum length (${input.content.length} > ${MAX_CONTENT_LENGTH})`,
        ),
      );
    }
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Memory confidence must be a finite number in [0, 1], got ${input.confidence}`,
        ),
      );
    }
    try {
      const id = randomUUID();
      const now = Date.now();
      const tags = JSON.stringify(input.tags ?? []);
      const metadata = JSON.stringify(input.metadata ?? {});
      const sensitive = input.sensitive ? 1 : 0;
      const userId = input.userId ?? "default";

      this.db
        .query(
          `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata, sensitive, user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
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
          sensitive,
          userId,
        );

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
        sensitive: input.sensitive ?? false,
      };

      this.logger.debug("create", `Created memory ${id}`, { type: input.type, layer: input.layer });
      return Ok(memory);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create memory", cause));
    }
  }

  /** Get a memory by ID without updating accessed_at or access_count. */
  getWithoutTouch(id: string): Result<Memory | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | null;
      return Ok(row ? rowToMemory(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get memory ${id}`, cause));
    }
  }

  /** Get a memory by ID. Also updates accessed_at and access_count (touch on read). */
  get(id: string): Result<Memory | null, EidolonError> {
    try {
      // Wrap read + touch in a transaction for atomicity
      const txn = this.db.transaction(() => {
        const row = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | null;

        if (!row) {
          return null;
        }

        // Touch: update accessed_at and increment access_count
        const now = Date.now();
        this.db.query("UPDATE memories SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?").run(now, id);

        const memory = rowToMemory(row);
        return {
          ...memory,
          accessedAt: now,
          accessCount: memory.accessCount + 1,
        };
      });

      const result = txn();
      return Ok(result);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get memory ${id}`, cause));
    }
  }

  /** Update an existing memory. Returns the updated memory or error if not found. */
  update(id: string, input: UpdateMemoryInput): Result<Memory, EidolonError> {
    if (input.content !== undefined && input.content.length > MAX_CONTENT_LENGTH) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Memory content exceeds maximum length (${input.content.length} > ${MAX_CONTENT_LENGTH})`,
        ),
      );
    }
    if (
      input.confidence !== undefined &&
      (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
    ) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Memory confidence must be a finite number in [0, 1], got ${input.confidence}`,
        ),
      );
    }
    try {
      // Wrap check + update + re-read in a transaction for atomicity
      const txn = this.db.transaction(() => {
        const existing = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | null;
        if (!existing) {
          return null;
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
        if (input.sensitive !== undefined) {
          setClauses.push("sensitive = ?");
          params.push(input.sensitive ? 1 : 0);
        }

        params.push(id);
        this.db.query(`UPDATE memories SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

        // Re-read the updated row
        return this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | null;
      });

      const updated = txn();
      if (!updated) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Memory ${id} not found`));
      }
      return Ok(rowToMemory(updated));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update memory ${id}`, cause));
    }
  }

  /** Delete a memory by ID. */
  delete(id: string): Result<void, EidolonError> {
    try {
      // Wrap check + delete in a transaction for atomicity
      const txn = this.db.transaction(() => {
        const existing = this.db.query("SELECT 1 FROM memories WHERE id = ?").get(id);
        if (!existing) {
          return false;
        }
        this.db.query("DELETE FROM memories WHERE id = ?").run(id);
        return true;
      });

      const deleted = txn();
      if (!deleted) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Memory ${id} not found`));
      }
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
      const VALID_ORDER_BY = new Set(["created_at", "updated_at", "accessed_at", "confidence"]);
      const VALID_ORDER = new Set(["asc", "desc"]);
      const orderBy = VALID_ORDER_BY.has(options?.orderBy ?? "") ? options?.orderBy : "created_at";
      const order = VALID_ORDER.has(options?.order ?? "") ? options?.order : "desc";
      const limit = Math.max(1, Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
      const offset = Math.max(0, options?.offset ?? 0);

      const sql = `SELECT * FROM memories ${where} ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = this.db.query(sql).all(...params) as MemoryRow[];
      return Ok(rows.map(rowToMemory));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list memories", cause));
    }
  }

  /** Count memories matching optional type and layer filters. */
  count(types?: readonly string[], layers?: readonly string[]): Result<number, EidolonError> {
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
    if (!query.trim()) return Ok([]);
    try {
      const maxResults = Math.max(1, Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));

      // Sanitize query to prevent FTS5 operator injection by wrapping in quotes
      const sanitized = `"${query.replace(/"/g, '""')}"`;

      const rows = this.db
        .query(
          `SELECT m.*, f.rank
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ?
           ORDER BY f.rank
           LIMIT ?`,
        )
        .all(sanitized, maxResults) as Array<MemoryRow & { rank: number }>;

      const results = rows.map((row) => ({
        memory: rowToMemory(row),
        rank: -row.rank, // FTS5 rank is negative; negate for positive score
      }));

      this.logger.debug("search", "FTS search completed", { resultCount: results.length });
      return Ok(results);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Full-text search failed", cause));
    }
  }

  /** Delete short_term memories older than cutoffMs. Returns number of deleted rows. */
  pruneExpired(cutoffMs: number): Result<number, EidolonError> {
    try {
      // Wrap count + delete in a transaction for atomicity
      const txn = this.db.transaction(() => {
        // Count matching rows first (DELETE changes count is inflated by FTS triggers)
        const countRow = this.db
          .query("SELECT COUNT(*) as count FROM memories WHERE layer = 'short_term' AND created_at < ?")
          .get(cutoffMs) as { count: number };
        const count = countRow.count;

        if (count > 0) {
          this.db.query("DELETE FROM memories WHERE layer = 'short_term' AND created_at < ?").run(cutoffMs);
        }

        return count;
      });

      const count = txn();
      this.logger.debug("prune", `Pruned ${count} expired short_term memories`);
      return Ok(count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to prune expired memories", cause));
    }
  }

  /**
   * Find memories whose embeddings are similar to a given embedding.
   * Returns memories sorted by descending cosine similarity, along with the
   * similarity score. Only memories with embeddings stored are considered.
   *
   * Used by MemoryConsolidator to find duplicates and update candidates.
   */
  findSimilar(
    embedding: Float32Array,
    limit: number,
    minSimilarity?: number,
  ): Result<Array<{ memory: Memory; similarity: number }>, EidolonError> {
    return findSimilarMemories(this.db, embedding, limit, minSimilarity);
  }

  /** Bulk create memories within a single transaction. */
  createBatch(inputs: readonly CreateMemoryInput[]): Result<Memory[], EidolonError> {
    return createMemoryBatch(this.db, this.logger, inputs);
  }

  /**
   * Run a callback within a database transaction for atomicity.
   * Supports nesting via SQLite savepoints.
   */
  withTransaction<T>(fn: () => T): T {
    const txn = this.db.transaction(fn);
    return txn();
  }
}
