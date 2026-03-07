/**
 * KGRelationStore triple query methods -- extracted from relations.ts.
 *
 * Provides operations for querying triples involving specific entities
 * or all triples in the knowledge graph.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { TripleResult, TripleWithIds } from "./relations.ts";

// ---------------------------------------------------------------------------
// Internal row types
// ---------------------------------------------------------------------------

interface TripleRow {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
  readonly confidence: number;
}

interface TripleIdRow {
  readonly subject_id: string;
  readonly predicate: string;
  readonly object_id: string;
  readonly confidence: number;
}

// ---------------------------------------------------------------------------
// Triple query functions
// ---------------------------------------------------------------------------

/**
 * Get triples involving any of the given entity IDs.
 * Returns (subject_name, predicate, object_name, confidence) for display.
 */
export function getTriplesForEntities(
  db: Database,
  entityIds: readonly string[],
  limit?: number,
): Result<TripleResult[], EidolonError> {
  if (entityIds.length === 0) return Ok([]);
  try {
    const maxResults = limit ?? 50;
    const placeholders = entityIds.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT
           s.name AS subject,
           r.type AS predicate,
           t.name AS object,
           r.confidence
         FROM kg_relations r
         JOIN kg_entities s ON s.id = r.source_id
         JOIN kg_entities t ON t.id = r.target_id
         WHERE r.source_id IN (${placeholders}) OR r.target_id IN (${placeholders})
         ORDER BY r.confidence DESC, r.created_at DESC
         LIMIT ?`,
      )
      .all(...entityIds, ...entityIds, maxResults) as TripleRow[];

    return Ok(
      rows.map((r) => ({
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        confidence: r.confidence,
      })),
    );
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get triples for entities", cause));
  }
}

/**
 * Get all triples with entity IDs (not names) for ComplEx embedding training.
 * Returns (subject_id, predicate, object_id, confidence).
 */
export function getAllTriplesWithIds(
  db: Database,
  limit?: number,
): Result<TripleWithIds[], EidolonError> {
  try {
    const maxResults = limit ?? 100;
    const rows = db
      .query(
        `SELECT
           r.source_id AS subject_id,
           r.type AS predicate,
           r.target_id AS object_id,
           r.confidence
         FROM kg_relations r
         ORDER BY r.created_at DESC
         LIMIT ?`,
      )
      .all(maxResults) as TripleIdRow[];

    return Ok(
      rows.map((r) => ({
        subjectId: r.subject_id,
        predicate: r.predicate,
        objectId: r.object_id,
        confidence: r.confidence,
      })),
    );
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get all triples with IDs", cause));
  }
}

/** Get all triples as (subject_name, predicate, object_name) for display. */
export function getAllTriples(
  db: Database,
  limit?: number,
): Result<TripleResult[], EidolonError> {
  try {
    const maxResults = limit ?? 100;
    const rows = db
      .query(
        `SELECT
           s.name AS subject,
           r.type AS predicate,
           t.name AS object,
           r.confidence
         FROM kg_relations r
         JOIN kg_entities s ON s.id = r.source_id
         JOIN kg_entities t ON t.id = r.target_id
         ORDER BY r.created_at DESC
         LIMIT ?`,
      )
      .all(maxResults) as TripleRow[];

    return Ok(
      rows.map((r) => ({
        subject: r.subject,
        predicate: r.predicate,
        object: r.object,
        confidence: r.confidence,
      })),
    );
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get all triples", cause));
  }
}
