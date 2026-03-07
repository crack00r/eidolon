/**
 * KGRelationStore -- CRUD operations on the `kg_relations` table in memory.db.
 *
 * Provides create, read, delete, find-by-subject/object/entity, find-triple,
 * update confidence, count, list predicates, and get-all-triples operations.
 * All methods return Result<T, EidolonError>.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, KGRelation, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import {
  getAllTriples as getAllTriplesImpl,
  getAllTriplesWithIds as getAllTriplesWithIdsImpl,
  getTriplesForEntities as getTriplesForEntitiesImpl,
} from "./relations-triples.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RelationPredicate =
  | "uses"
  | "owns"
  | "runs_on"
  | "depends_on"
  | "prefers"
  | "creates"
  | "is_part_of"
  | "located_in"
  | "has_property"
  | "related_to"
  | "contradicts"
  | "replaces";

/** Valid relation predicates for runtime validation. */
const VALID_RELATION_PREDICATES = new Set<string>([
  "uses",
  "owns",
  "runs_on",
  "depends_on",
  "prefers",
  "creates",
  "is_part_of",
  "located_in",
  "has_property",
  "related_to",
  "contradicts",
  "replaces",
]);

export interface CreateRelationInput {
  readonly sourceId: string;
  readonly targetId: string;
  readonly type: RelationPredicate;
  readonly confidence?: number;
  readonly source: string;
}

export interface TripleResult {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: number;
}

/** Triple with entity IDs (not names) for embedding training. */
export interface TripleWithIds {
  readonly subjectId: string;
  readonly predicate: string;
  readonly objectId: string;
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Internal row shape from SQLite
// ---------------------------------------------------------------------------

interface RelationRow {
  readonly id: string;
  readonly source_id: string;
  readonly target_id: string;
  readonly type: string;
  readonly confidence: number;
  readonly source: string;
  readonly created_at: number;
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRelation(row: RelationRow): KGRelation {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type,
    confidence: row.confidence,
    source: row.source,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// KGRelationStore
// ---------------------------------------------------------------------------

export class KGRelationStore {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("kg-relation-store");
  }

  /** Create a relation (triple). */
  create(input: CreateRelationInput): Result<KGRelation, EidolonError> {
    // Validate relation type against allowed predicates
    if (!VALID_RELATION_PREDICATES.has(input.type)) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Invalid relation type "${input.type}". Must be one of: ${[...VALID_RELATION_PREDICATES].join(", ")}`,
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
          `Relation confidence must be a finite number in [0, 1], got ${input.confidence}`,
        ),
      );
    }
    try {
      const id = randomUUID();
      const now = Date.now();
      const confidence = input.confidence ?? 1.0;

      this.db
        .query(
          `INSERT INTO kg_relations (id, source_id, target_id, type, confidence, source, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.sourceId, input.targetId, input.type, confidence, input.source, now);

      const relation: KGRelation = {
        id,
        sourceId: input.sourceId,
        targetId: input.targetId,
        type: input.type,
        confidence,
        source: input.source,
        createdAt: now,
      };

      this.logger.debug("create", `Created relation ${id}`, {
        type: input.type,
        sourceId: input.sourceId,
        targetId: input.targetId,
      });
      return Ok(relation);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create relation", cause));
    }
  }

  /** Get relation by ID. */
  get(id: string): Result<KGRelation | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM kg_relations WHERE id = ?").get(id) as RelationRow | null;
      return Ok(row ? rowToRelation(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get relation ${id}`, cause));
    }
  }

  /** Find relations BY subject entity. */
  findBySubject(entityId: string): Result<KGRelation[], EidolonError> {
    try {
      const rows = this.db
        .query("SELECT * FROM kg_relations WHERE source_id = ? ORDER BY created_at DESC")
        .all(entityId) as RelationRow[];
      return Ok(rows.map(rowToRelation));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to find relations by subject ${entityId}`, cause));
    }
  }

  /** Find relations pointing TO an entity. */
  findByObject(entityId: string): Result<KGRelation[], EidolonError> {
    try {
      const rows = this.db
        .query("SELECT * FROM kg_relations WHERE target_id = ? ORDER BY created_at DESC")
        .all(entityId) as RelationRow[];
      return Ok(rows.map(rowToRelation));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to find relations by object ${entityId}`, cause));
    }
  }

  /** Find all relations for an entity (as subject or object). */
  findByEntity(entityId: string): Result<KGRelation[], EidolonError> {
    try {
      const rows = this.db
        .query("SELECT * FROM kg_relations WHERE source_id = ? OR target_id = ? ORDER BY created_at DESC")
        .all(entityId, entityId) as RelationRow[];
      return Ok(rows.map(rowToRelation));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to find relations for entity ${entityId}`, cause));
    }
  }

  /** Find a specific triple (subject + predicate + object). */
  findTriple(sourceId: string, type: string, targetId: string): Result<KGRelation | null, EidolonError> {
    try {
      const row = this.db
        .query("SELECT * FROM kg_relations WHERE source_id = ? AND type = ? AND target_id = ? LIMIT 1")
        .get(sourceId, type, targetId) as RelationRow | null;
      return Ok(row ? rowToRelation(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to find triple", cause));
    }
  }

  /** Delete a relation. */
  delete(id: string): Result<void, EidolonError> {
    try {
      const existing = this.db.query("SELECT 1 FROM kg_relations WHERE id = ?").get(id);
      if (!existing) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Relation ${id} not found`));
      }
      this.db.query("DELETE FROM kg_relations WHERE id = ?").run(id);
      this.logger.debug("delete", `Deleted relation ${id}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete relation ${id}`, cause));
    }
  }

  /** Delete all relations for an entity. */
  deleteByEntity(entityId: string): Result<number, EidolonError> {
    try {
      const countRow = this.db
        .query("SELECT COUNT(*) as count FROM kg_relations WHERE source_id = ? OR target_id = ?")
        .get(entityId, entityId) as { count: number };
      const count = countRow.count;

      if (count > 0) {
        this.db.query("DELETE FROM kg_relations WHERE source_id = ? OR target_id = ?").run(entityId, entityId);
      }

      this.logger.debug("deleteByEntity", `Deleted ${count} relations for entity ${entityId}`);
      return Ok(count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete relations for entity ${entityId}`, cause));
    }
  }

  /** Update confidence of a relation. */
  updateConfidence(id: string, confidence: number): Result<void, EidolonError> {
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Relation confidence must be a finite number in [0, 1], got ${confidence}`,
        ),
      );
    }
    try {
      const existing = this.db.query("SELECT 1 FROM kg_relations WHERE id = ?").get(id);
      if (!existing) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Relation ${id} not found`));
      }
      this.db.query("UPDATE kg_relations SET confidence = ? WHERE id = ?").run(confidence, id);
      this.logger.debug("updateConfidence", `Updated confidence for relation ${id}`, { confidence });
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update confidence for relation ${id}`, cause));
    }
  }

  /** Count relations. */
  count(type?: string): Result<number, EidolonError> {
    try {
      if (type) {
        const row = this.db.query("SELECT COUNT(*) as count FROM kg_relations WHERE type = ?").get(type) as {
          count: number;
        };
        return Ok(row.count);
      }
      const row = this.db.query("SELECT COUNT(*) as count FROM kg_relations").get() as { count: number };
      return Ok(row.count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to count relations", cause));
    }
  }

  /** List all unique predicates used. */
  listPredicates(): Result<string[], EidolonError> {
    try {
      const rows = this.db.query("SELECT DISTINCT type FROM kg_relations ORDER BY type").all() as Array<{
        type: string;
      }>;
      return Ok(rows.map((r) => r.type));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list predicates", cause));
    }
  }

  /**
   * Get triples involving any of the given entity IDs.
   * Returns (subject_name, predicate, object_name, confidence) for display.
   */
  getTriplesForEntities(entityIds: readonly string[], limit?: number): Result<TripleResult[], EidolonError> {
    return getTriplesForEntitiesImpl(this.db, entityIds, limit);
  }

  /**
   * Get all triples with entity IDs (not names) for ComplEx embedding training.
   * Returns (subject_id, predicate, object_id, confidence).
   */
  getAllTriplesWithIds(limit?: number): Result<TripleWithIds[], EidolonError> {
    return getAllTriplesWithIdsImpl(this.db, limit);
  }

  /** Get all triples as (subject_name, predicate, object_name) for display. */
  getAllTriples(limit?: number): Result<TripleResult[], EidolonError> {
    return getAllTriplesImpl(this.db, limit);
  }
}
