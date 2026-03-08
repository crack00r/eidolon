/**
 * Entity resolution and merge logic for KGEntityStore.
 * Extracted from entities.ts to keep files under 300 lines.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, KGEntity, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { stringSimilarity } from "../dreaming/housekeeping.ts";
import type { CreateEntityInput, EntityResolutionThresholds, EntityType, KGEntityStore } from "./entities.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Internal row shape from SQLite. */
interface EntityRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly attributes: string;
  readonly created_at: number;
  readonly updated_at: number;
}

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

function rowToEntity(row: EntityRow): KGEntity {
  let attributes: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(row.attributes);
    attributes =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
  } catch {
    attributes = {};
  }

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    attributes,
    createdAt: row.created_at,
  };
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
    const rows = db.query("SELECT * FROM kg_entities WHERE type = ? LIMIT ?").all(type, MAX_ENTITY_CANDIDATES) as EntityRow[];

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
    const source = db.query("SELECT 1 FROM kg_entities WHERE id = ?").get(sourceId);
    if (!source) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Source entity ${sourceId} not found`));
    }
    const target = db.query("SELECT 1 FROM kg_entities WHERE id = ?").get(targetId);
    if (!target) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Target entity ${targetId} not found`));
    }

    const mergeFn = db.transaction(() => {
      db.query("UPDATE kg_relations SET source_id = ? WHERE source_id = ?").run(targetId, sourceId);
      db.query("UPDATE kg_relations SET target_id = ? WHERE target_id = ?").run(targetId, sourceId);
      db.query("DELETE FROM kg_relations WHERE source_id = ? AND source_id = target_id").run(targetId);
      db.query("DELETE FROM kg_entities WHERE id = ?").run(sourceId);
    });

    mergeFn();

    logger.debug("merge", `Merged entity ${sourceId} into ${targetId}`);
    return Ok(undefined);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to merge entities`, cause));
  }
}
