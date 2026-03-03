/**
 * KGEntityStore -- CRUD operations on the `kg_entities` table in memory.db.
 *
 * Provides create, read, update, delete, find-or-create, search, merge,
 * and list operations. All methods return Result<T, EidolonError>.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, KGEntity, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { stringSimilarity } from "../dreaming/housekeeping.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EntityType = "person" | "technology" | "device" | "project" | "concept" | "place";

/** Valid entity types for runtime validation. */
const VALID_ENTITY_TYPES = new Set<string>(["person", "technology", "device", "project", "concept", "place"]);

/**
 * Per-type similarity thresholds for entity resolution.
 * Matches the `entityResolution` config schema from protocol.
 */
export interface EntityResolutionThresholds {
  readonly personThreshold: number;
  readonly technologyThreshold: number;
  readonly conceptThreshold: number;
}

/** Default thresholds matching the Zod schema defaults in protocol. */
const DEFAULT_ENTITY_RESOLUTION_THRESHOLDS: EntityResolutionThresholds = {
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

export interface CreateEntityInput {
  readonly name: string;
  readonly type: EntityType;
  readonly attributes?: Record<string, unknown>;
}

export interface UpdateEntityInput {
  readonly name?: string;
  readonly type?: EntityType;
  readonly attributes?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal row shape from SQLite
// ---------------------------------------------------------------------------

interface EntityRow {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly attributes: string;
  readonly created_at: number;
  readonly updated_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Maximum allowed entity name length. */
const MAX_ENTITY_NAME_LENGTH = 500;

/**
 * Strip control characters (U+0000–U+001F, U+007F–U+009F) from a string.
 */
function stripControlChars(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control characters for security
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

// ---------------------------------------------------------------------------
// KGEntityStore
// ---------------------------------------------------------------------------

export class KGEntityStore {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly defaultThresholds: EntityResolutionThresholds;

  constructor(db: Database, logger: Logger, thresholds?: EntityResolutionThresholds) {
    this.db = db;
    this.logger = logger.child("kg-entity-store");
    this.defaultThresholds = thresholds ?? DEFAULT_ENTITY_RESOLUTION_THRESHOLDS;
  }

  /** Create a new entity. Generates UUID for ID. */
  create(input: CreateEntityInput): Result<KGEntity, EidolonError> {
    // Validate entity type against allowed set
    if (!VALID_ENTITY_TYPES.has(input.type)) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Invalid entity type "${input.type}". Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}`,
        ),
      );
    }
    // Finding #19: Validate entity name length and strip control characters
    const sanitizedName = stripControlChars(input.name).trim();
    if (sanitizedName.length === 0) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Entity name must not be empty"));
    }
    if (sanitizedName.length > MAX_ENTITY_NAME_LENGTH) {
      return Err(
        createError(
          ErrorCode.DB_QUERY_FAILED,
          `Entity name too long: ${sanitizedName.length} characters (max ${MAX_ENTITY_NAME_LENGTH})`,
        ),
      );
    }

    try {
      const id = randomUUID();
      const now = Date.now();
      const attributes = JSON.stringify(input.attributes ?? {});

      this.db
        .query(
          `INSERT INTO kg_entities (id, name, type, attributes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, sanitizedName, input.type, attributes, now, now);

      const entity: KGEntity = {
        id,
        name: sanitizedName,
        type: input.type,
        attributes: input.attributes ?? {},
        createdAt: now,
      };

      this.logger.debug("create", `Created entity ${id}`, { name: input.name, type: input.type });
      return Ok(entity);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create entity", cause));
    }
  }

  /** Get entity by ID. */
  get(id: string): Result<KGEntity | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM kg_entities WHERE id = ?").get(id) as EntityRow | null;
      return Ok(row ? rowToEntity(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get entity ${id}`, cause));
    }
  }

  /** Find entity by name (case-insensitive). Returns first match. */
  findByName(name: string): Result<KGEntity | null, EidolonError> {
    try {
      const row = this.db
        .query("SELECT * FROM kg_entities WHERE LOWER(name) = LOWER(?) LIMIT 1")
        .get(name) as EntityRow | null;
      return Ok(row ? rowToEntity(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to find entity by name "${name}"`, cause));
    }
  }

  /** Find entities by type. */
  findByType(type: EntityType, limit?: number): Result<KGEntity[], EidolonError> {
    try {
      const maxResults = limit ?? 100;
      const rows = this.db
        .query("SELECT * FROM kg_entities WHERE type = ? ORDER BY created_at DESC LIMIT ?")
        .all(type, maxResults) as EntityRow[];
      return Ok(rows.map(rowToEntity));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to find entities by type "${type}"`, cause));
    }
  }

  /** Update an entity. */
  update(id: string, input: UpdateEntityInput): Result<KGEntity, EidolonError> {
    try {
      const existing = this.db.query("SELECT * FROM kg_entities WHERE id = ?").get(id) as EntityRow | null;
      if (!existing) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Entity ${id} not found`));
      }

      const now = Date.now();
      const setClauses: string[] = ["updated_at = ?"];
      const params: Array<string | number> = [now];

      if (input.name !== undefined) {
        const sanitizedName = stripControlChars(input.name).trim();
        if (sanitizedName.length === 0) {
          return Err(createError(ErrorCode.DB_QUERY_FAILED, "Entity name must not be empty"));
        }
        if (sanitizedName.length > MAX_ENTITY_NAME_LENGTH) {
          return Err(
            createError(
              ErrorCode.DB_QUERY_FAILED,
              `Entity name too long: ${sanitizedName.length} characters (max ${MAX_ENTITY_NAME_LENGTH})`,
            ),
          );
        }
        setClauses.push("name = ?");
        params.push(sanitizedName);
      }
      if (input.type !== undefined) {
        if (!VALID_ENTITY_TYPES.has(input.type)) {
          return Err(
            createError(
              ErrorCode.DB_QUERY_FAILED,
              `Invalid entity type "${input.type}". Must be one of: ${[...VALID_ENTITY_TYPES].join(", ")}`,
            ),
          );
        }
        setClauses.push("type = ?");
        params.push(input.type);
      }
      if (input.attributes !== undefined) {
        setClauses.push("attributes = ?");
        params.push(JSON.stringify(input.attributes));
      }

      params.push(id);
      this.db.query(`UPDATE kg_entities SET ${setClauses.join(", ")} WHERE id = ?`).run(...params);

      const updated = this.db.query("SELECT * FROM kg_entities WHERE id = ?").get(id) as EntityRow;
      this.logger.debug("update", `Updated entity ${id}`);
      return Ok(rowToEntity(updated));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update entity ${id}`, cause));
    }
  }

  /** Delete an entity (cascades to relations via foreign key). */
  delete(id: string): Result<void, EidolonError> {
    try {
      const existing = this.db.query("SELECT 1 FROM kg_entities WHERE id = ?").get(id);
      if (!existing) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Entity ${id} not found`));
      }
      this.db.query("DELETE FROM kg_entities WHERE id = ?").run(id);
      this.logger.debug("delete", `Deleted entity ${id}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete entity ${id}`, cause));
    }
  }

  /** Find or create: if entity with same name+type exists, return it; otherwise create. */
  findOrCreate(input: CreateEntityInput): Result<{ entity: KGEntity; created: boolean }, EidolonError> {
    try {
      const row = this.db
        .query("SELECT * FROM kg_entities WHERE LOWER(name) = LOWER(?) AND type = ? LIMIT 1")
        .get(input.name, input.type) as EntityRow | null;

      if (row) {
        return Ok({ entity: rowToEntity(row), created: false });
      }

      const createResult = this.create(input);
      if (!createResult.ok) {
        return createResult;
      }
      return Ok({ entity: createResult.value, created: true });
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to find or create entity", cause));
    }
  }

  /** List all entities with optional type filter. */
  list(options?: { type?: EntityType; limit?: number; offset?: number }): Result<KGEntity[], EidolonError> {
    try {
      const whereClauses: string[] = [];
      const params: Array<string | number> = [];

      if (options?.type) {
        whereClauses.push("type = ?");
        params.push(options.type);
      }

      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
      const limit = options?.limit ?? 100;
      const offset = options?.offset ?? 0;

      params.push(limit, offset);
      const rows = this.db
        .query(`SELECT * FROM kg_entities ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params) as EntityRow[];

      return Ok(rows.map(rowToEntity));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list entities", cause));
    }
  }

  /** Count entities. */
  count(type?: EntityType): Result<number, EidolonError> {
    try {
      if (type) {
        const row = this.db.query("SELECT COUNT(*) as count FROM kg_entities WHERE type = ?").get(type) as {
          count: number;
        };
        return Ok(row.count);
      }
      const row = this.db.query("SELECT COUNT(*) as count FROM kg_entities").get() as { count: number };
      return Ok(row.count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to count entities", cause));
    }
  }

  /** Search entities by name prefix (for autocomplete/resolution). */
  searchByName(prefix: string, limit?: number): Result<KGEntity[], EidolonError> {
    try {
      const maxResults = limit ?? 10;
      const escaped = prefix.replace(/[%_\\]/g, (ch) => `\\${ch}`);
      const rows = this.db
        .query("SELECT * FROM kg_entities WHERE LOWER(name) LIKE LOWER(?) ESCAPE '\\' ORDER BY name LIMIT ?")
        .all(`${escaped}%`, maxResults) as EntityRow[];
      return Ok(rows.map(rowToEntity));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to search entities by prefix "${prefix}"`, cause));
    }
  }

  /**
   * Find entities with names similar to the given name, using per-type
   * thresholds from the entity resolution config.
   *
   * This powers entity deduplication: before creating a new entity, call
   * this to check if a sufficiently similar one already exists.
   *
   * @param name       - The candidate entity name.
   * @param type       - The entity type (determines which threshold to use).
   * @param thresholds - Per-type similarity thresholds from config.
   * @returns Matching entities that exceed the threshold for the given type.
   */
  findSimilar(
    name: string,
    type: EntityType,
    thresholds?: EntityResolutionThresholds,
  ): Result<Array<{ entity: KGEntity; similarity: number }>, EidolonError> {
    const resolvedThresholds = thresholds ?? this.defaultThresholds;
    const threshold = getThresholdForType(type, resolvedThresholds);

    try {
      // Load all entities of the same type (entity count per type is typically small)
      const rows = this.db
        .query("SELECT * FROM kg_entities WHERE type = ?")
        .all(type) as EntityRow[];

      const matches: Array<{ entity: KGEntity; similarity: number }> = [];

      for (const row of rows) {
        const sim = stringSimilarity(name, row.name);
        if (sim >= threshold) {
          matches.push({ entity: rowToEntity(row), similarity: sim });
        }
      }

      // Sort by similarity descending
      matches.sort((a, b) => b.similarity - a.similarity);

      this.logger.debug("findSimilar", `Found ${matches.length} similar entities for "${name}"`, {
        type,
        threshold,
        candidateCount: rows.length,
      });

      return Ok(matches);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to find similar entities for "${name}"`, cause));
    }
  }

  /**
   * Find or create with deduplication: looks for existing entities of the
   * same type whose name exceeds the configured similarity threshold.
   * If a similar entity is found, returns it; otherwise creates a new one.
   *
   * @param input      - The entity to find or create.
   * @param thresholds - Per-type similarity thresholds from config.
   */
  findOrCreateWithResolution(
    input: CreateEntityInput,
    thresholds?: EntityResolutionThresholds,
  ): Result<{ entity: KGEntity; created: boolean }, EidolonError> {
    // First check for similar entities using configurable thresholds
    const similarResult = this.findSimilar(input.name, input.type, thresholds);
    if (!similarResult.ok) return similarResult;

    if (similarResult.value.length > 0) {
      const best = similarResult.value[0];
      if (best) {
        this.logger.debug("findOrCreateWithResolution", `Resolved "${input.name}" to existing entity "${best.entity.name}"`, {
          similarity: best.similarity,
          type: input.type,
        });
        return Ok({ entity: best.entity, created: false });
      }
    }

    // No similar entity found, create a new one
    const createResult = this.create(input);
    if (!createResult.ok) return createResult;
    return Ok({ entity: createResult.value, created: true });
  }

  /** Merge two entities: keep target, move all relations from source to target, delete source. */
  merge(sourceId: string, targetId: string): Result<void, EidolonError> {
    try {
      const source = this.db.query("SELECT 1 FROM kg_entities WHERE id = ?").get(sourceId);
      if (!source) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Source entity ${sourceId} not found`));
      }
      const target = this.db.query("SELECT 1 FROM kg_entities WHERE id = ?").get(targetId);
      if (!target) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Target entity ${targetId} not found`));
      }

      const mergeFn = this.db.transaction(() => {
        // Move outgoing relations (source_id = sourceId) to targetId
        this.db.query("UPDATE kg_relations SET source_id = ? WHERE source_id = ?").run(targetId, sourceId);

        // Move incoming relations (target_id = sourceId) to targetId
        this.db.query("UPDATE kg_relations SET target_id = ? WHERE target_id = ?").run(targetId, sourceId);

        // Delete self-loop relations created by the merge (scoped to targetId only)
        this.db.query("DELETE FROM kg_relations WHERE source_id = ? AND source_id = target_id").run(targetId);

        // Delete source entity
        this.db.query("DELETE FROM kg_entities WHERE id = ?").run(sourceId);
      });

      mergeFn();

      this.logger.debug("merge", `Merged entity ${sourceId} into ${targetId}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to merge entities`, cause));
    }
  }
}
