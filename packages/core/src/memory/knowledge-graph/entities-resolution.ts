/**
 * Entity resolution and merge logic for KGEntityStore.
 * Extracted from entities.ts to keep files under 300 lines.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, KGEntity, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { stringSimilarity } from "../dreaming/housekeeping.ts";
import {
  type CreateEntityInput,
  type EntityResolutionThresholds,
  type EntityRow,
  type EntityType,
  type KGEntityStore,
  rowToEntity,
} from "./entities.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default thresholds matching the Zod schema defaults in protocol. */
const _DEFAULT_ENTITY_RESOLUTION_THRESHOLDS: EntityResolutionThresholds = {
  personThreshold: 0.95,
  technologyThreshold: 0.9,
  conceptThreshold: 0.85,
};

/**
 * Map entity type to the appropriate resolution threshold.
 * Types not explicitly configured fall back to the technology threshold.
 */
function getThresholdForType(type: string, thresholds: EntityResolutionThresholds): number {
  switch (type) {
    case "person":
      return thresholds.personThreshold;
    case "technology":
    case "device":
    case "project":
      return thresholds.technologyThreshold;
    case "concept":
    case "place":
      return thresholds.conceptThreshold;
    default:
      return thresholds.technologyThreshold;
  }
}

// ---------------------------------------------------------------------------
// findSimilar
// ---------------------------------------------------------------------------

/**
 * Find entities with names similar to the given name, using per-type
 * thresholds from the entity resolution config.
 */
export function findSimilarEntities(
  db: Database,
  logger: Logger,
  name: string,
  type: EntityType,
  defaultThresholds: EntityResolutionThresholds,
  thresholds?: EntityResolutionThresholds,
): Result<Array<{ entity: KGEntity; similarity: number }>, EidolonError> {
  const resolvedThresholds = thresholds ?? defaultThresholds;
  const threshold = getThresholdForType(type, resolvedThresholds);

  try {
    const MAX_ENTITY_CANDIDATES = 5000;
    const rows = db
      .query("SELECT * FROM kg_entities WHERE type = ? LIMIT ?")
      .all(type, MAX_ENTITY_CANDIDATES) as EntityRow[];

    const matches: Array<{ entity: KGEntity; similarity: number }> = [];

    for (const row of rows) {
      const sim = stringSimilarity(name, row.name);
      if (sim >= threshold) {
        matches.push({ entity: rowToEntity(row), similarity: sim });
      }
    }

    matches.sort((a, b) => b.similarity - a.similarity);

    logger.debug("findSimilar", `Found ${matches.length} similar entities for "${name}"`, {
      type,
      threshold,
      candidateCount: rows.length,
    });

    return Ok(matches);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to find similar entities for "${name}"`, cause));
  }
}

// ---------------------------------------------------------------------------
// findOrCreateWithResolution
// ---------------------------------------------------------------------------

/**
 * Find or create with deduplication: looks for existing entities of the
 * same type whose name exceeds the configured similarity threshold.
 * If a similar entity is found, returns it; otherwise creates a new one.
 */
export function findOrCreateWithResolution(
  store: KGEntityStore,
  logger: Logger,
  input: CreateEntityInput,
  thresholds?: EntityResolutionThresholds,
): Result<{ entity: KGEntity; created: boolean }, EidolonError> {
  const similarResult = store.findSimilar(input.name, input.type, thresholds);
  if (!similarResult.ok) return similarResult;

  if (similarResult.value.length > 0) {
    const best = similarResult.value[0];
    if (best) {
      logger.debug("findOrCreateWithResolution", `Resolved "${input.name}" to existing entity "${best.entity.name}"`, {
        similarity: best.similarity,
        type: input.type,
      });
      return Ok({ entity: best.entity, created: false });
    }
  }

  const createResult = store.create(input);
  if (!createResult.ok) return createResult;
  return Ok({ entity: createResult.value, created: true });
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/** Merge two entities: keep target, move all relations from source to target, delete source. */
export function mergeEntities(
  db: Database,
  logger: Logger,
  sourceId: string,
  targetId: string,
): Result<void, EidolonError> {
  try {
    const mergeFn = db.transaction(() => {
      // Existence checks inside transaction to prevent TOCTOU race
      const source = db.query("SELECT 1 FROM kg_entities WHERE id = ?").get(sourceId);
      if (!source) {
        throw new Error(`Source entity ${sourceId} not found`);
      }
      const target = db.query("SELECT 1 FROM kg_entities WHERE id = ?").get(targetId);
      if (!target) {
        throw new Error(`Target entity ${targetId} not found`);
      }

      db.query("UPDATE kg_relations SET source_id = ? WHERE source_id = ?").run(targetId, sourceId);
      db.query("UPDATE kg_relations SET target_id = ? WHERE target_id = ?").run(targetId, sourceId);
      db.query("DELETE FROM kg_relations WHERE source_id = ? AND source_id = target_id").run(targetId);
      // Deduplicate relations involving targetId that now share the same (source_id, target_id, type) triple
      db.query(
        `DELETE FROM kg_relations
         WHERE (source_id = ? OR target_id = ?)
           AND rowid NOT IN (
             SELECT MIN(rowid) FROM kg_relations
             WHERE source_id = ? OR target_id = ?
             GROUP BY source_id, target_id, type
           )`,
      ).run(targetId, targetId, targetId, targetId);
      db.query("DELETE FROM kg_complex_embeddings WHERE entity_id = ?").run(sourceId);
      db.query("DELETE FROM kg_entities WHERE id = ?").run(sourceId);
    });

    mergeFn();

    logger.debug("merge", `Merged entity ${sourceId} into ${targetId}`);
    return Ok(undefined);
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    if (msg.includes("not found")) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, msg));
    }
    return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to merge entities", cause));
  }
}
