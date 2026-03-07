/**
 * ScopedMemoryStore -- user-scoped wrapper around MemoryStore.
 *
 * Adds user_id filtering to all memory operations so that each user's
 * memories are isolated. Falls back to DEFAULT_USER_ID for backward
 * compatibility with existing single-user data.
 *
 * This module does NOT modify the underlying MemoryStore. Instead it
 * provides a thin query-layer that prepends user_id conditions to SQL.
 * The actual `user_id` column is added via migration.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Memory, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { CreateMemoryInput, MemoryListOptions, MemoryRow } from "../memory/store-helpers.ts";
import {
  DEFAULT_LIST_LIMIT,
  MAX_BATCH_SIZE,
  MAX_CONTENT_LENGTH,
  MAX_LIST_LIMIT,
  rowToMemory,
} from "../memory/store-helpers.ts";
import { DEFAULT_USER_ID } from "./schema.ts";

// ---------------------------------------------------------------------------
// ScopedMemoryStore
// ---------------------------------------------------------------------------

export class ScopedMemoryStore {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly userId: string;

  constructor(db: Database, logger: Logger, userId?: string) {
    this.db = db;
    this.logger = logger.child("scoped-memory");
    this.userId = userId ?? DEFAULT_USER_ID;
  }

  /** The user ID this store is scoped to. */
  get scopedUserId(): string {
    return this.userId;
  }

  /** List memories for this user only. */
  list(options?: MemoryListOptions): Result<Memory[], EidolonError> {
    try {
      const whereClauses: string[] = ["user_id = ?"];
      const params: Array<string | number> = [this.userId];

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

      const where = `WHERE ${whereClauses.join(" AND ")}`;
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
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list scoped memories", cause));
    }
  }

  /** Count memories for this user only. */
  count(types?: readonly string[], layers?: readonly string[]): Result<number, EidolonError> {
    try {
      const whereClauses: string[] = ["user_id = ?"];
      const params: Array<string | number> = [this.userId];

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

      const where = `WHERE ${whereClauses.join(" AND ")}`;
      const row = this.db.query(`SELECT COUNT(*) as count FROM memories ${where}`).get(...params) as {
        count: number;
      };

      return Ok(row.count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to count scoped memories", cause));
    }
  }

  /**
   * Create a memory scoped to this user.
   * Sets the user_id column in the memories table.
   */
  create(input: CreateMemoryInput): Result<Memory, EidolonError> {
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
          this.userId,
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

      this.logger.debug("create", `Created scoped memory ${id}`, { userId: this.userId });
      return Ok(memory);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create scoped memory", cause));
    }
  }

  /** Full-text search scoped to this user. */
  searchText(query: string, limit?: number): Result<Array<{ memory: Memory; rank: number }>, EidolonError> {
    try {
      const maxResults = Math.max(1, Math.min(limit ?? 20, 1000));
      const sanitized = `"${query.replace(/"/g, '""')}"`;

      const rows = this.db
        .query(
          `SELECT m.*, f.rank
           FROM memories_fts f
           JOIN memories m ON m.rowid = f.rowid
           WHERE memories_fts MATCH ?
             AND m.user_id = ?
           ORDER BY f.rank
           LIMIT ?`,
        )
        .all(sanitized, this.userId, maxResults) as Array<MemoryRow & { rank: number }>;

      const results = rows.map((row) => ({
        memory: rowToMemory(row),
        rank: -row.rank,
      }));

      return Ok(results);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Scoped full-text search failed", cause));
    }
  }
}
