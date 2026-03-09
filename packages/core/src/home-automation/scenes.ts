/**
 * Scene engine for Home Automation.
 *
 * Manages named scenes (collections of HA service calls) stored in the
 * ha_scenes table. Supports CRUD operations and sequential execution
 * of scene actions.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, HAScene, HASceneAction, HAServiceResult, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface HASceneRow {
  id: string;
  name: string;
  actions: string;
  created_at: number;
  last_executed_at: number | null;
}

// ---------------------------------------------------------------------------
// Zod validation for parsed scene actions
// ---------------------------------------------------------------------------

const SceneActionSchema = z.object({
  entityId: z.string(),
  domain: z.string(),
  service: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

const SceneActionsArraySchema = z.array(SceneActionSchema);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Maximum number of actions per scene. */
const MAX_ACTIONS_PER_SCENE = 50;

/** Maximum number of scenes. */
const MAX_SCENES = 500;

// ---------------------------------------------------------------------------
// Service executor callback
// ---------------------------------------------------------------------------

/**
 * Function type for executing a single HA service call.
 * This is injected by the HAManager which handles the actual MCP/HTTP
 * communication with Home Assistant.
 */
export type ExecuteServiceFn = (
  entityId: string,
  domain: string,
  service: string,
  data?: Record<string, unknown>,
) => Promise<Result<HAServiceResult, EidolonError>>;

// ---------------------------------------------------------------------------
// HASceneEngine
// ---------------------------------------------------------------------------

export class HASceneEngine {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;

  constructor(db: Database, logger: Logger, eventBus: EventBus) {
    this.db = db;
    this.logger = logger.child("ha-scenes");
    this.eventBus = eventBus;
  }

  /** Create a new scene with a set of actions. */
  createScene(name: string, actions: readonly HASceneAction[]): Result<HAScene, EidolonError> {
    try {
      const trimmedName = name.trim();
      if (trimmedName.length === 0) {
        return Err(createError(ErrorCode.INVALID_INPUT, "Scene name must not be empty"));
      }

      if (actions.length > MAX_ACTIONS_PER_SCENE) {
        return Err(
          createError(ErrorCode.INVALID_INPUT, `Too many actions (${actions.length}, max ${MAX_ACTIONS_PER_SCENE})`),
        );
      }

      const id = randomUUID();
      const now = Date.now();
      const actionsJson = JSON.stringify(actions);

      const insertScene = this.db.transaction(() => {
        const countRow = this.db.query("SELECT COUNT(*) as cnt FROM ha_scenes").get() as { cnt: number } | null;
        if ((countRow?.cnt ?? 0) >= MAX_SCENES) {
          throw new Error(`LIMIT:Scene limit reached (max ${MAX_SCENES})`);
        }

        const existing = this.db.query("SELECT id FROM ha_scenes WHERE name = ?").get(trimmedName) as {
          id: string;
        } | null;
        if (existing) {
          throw new Error(`DUPLICATE:Scene with name "${trimmedName}" already exists`);
        }

        this.db
          .query(
            `INSERT INTO ha_scenes (id, name, actions, created_at, last_executed_at)
             VALUES (?, ?, ?, ?, NULL)`,
          )
          .run(id, trimmedName, actionsJson, now);
      });

      try {
        insertScene();
      } catch (txErr: unknown) {
        const msg = txErr instanceof Error ? txErr.message : String(txErr);
        if (msg.startsWith("LIMIT:") || msg.startsWith("DUPLICATE:")) {
          return Err(createError(ErrorCode.INVALID_INPUT, msg.slice(msg.indexOf(":") + 1)));
        }
        throw txErr;
      }

      const scene: HAScene = {
        id,
        name: trimmedName,
        actions,
        createdAt: now,
      };

      this.logger.info("createScene", `Created scene: ${trimmedName} (${actions.length} actions)`);
      return Ok(scene);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to create scene: "${name}"`, cause));
    }
  }

  /** Get a scene by ID. */
  getScene(id: string): Result<HAScene | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM ha_scenes WHERE id = ?").get(id) as HASceneRow | null;

      if (!row) return Ok(null);
      return Ok(rowToScene(row));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get scene: ${id}`, cause));
    }
  }

  /** List all scenes. */
  listScenes(): Result<HAScene[], EidolonError> {
    try {
      const rows = this.db.query("SELECT * FROM ha_scenes ORDER BY name ASC").all() as HASceneRow[];

      return Ok(rows.map(rowToScene));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list scenes", cause));
    }
  }

  /**
   * Execute a scene by ID.
   * Calls the executeService function for each action in order.
   * Publishes a "ha:scene_executed" event on completion.
   */
  async executeScene(id: string, executeService: ExecuteServiceFn): Promise<Result<HAServiceResult[], EidolonError>> {
    const sceneResult = this.getScene(id);
    if (!sceneResult.ok) return sceneResult;

    const scene = sceneResult.value;
    if (!scene) {
      return Err(createError(ErrorCode.HA_SCENE_NOT_FOUND, `Scene not found: ${id}`));
    }

    const results: HAServiceResult[] = [];
    const failures: string[] = [];
    for (const action of scene.actions) {
      const result = await executeService(action.entityId, action.domain, action.service, action.data);
      if (!result.ok) {
        this.logger.warn(
          "executeScene",
          `Action failed in scene "${scene.name}" (${action.entityId}/${action.service}): ${result.error.message}`,
        );
        failures.push(`${action.entityId}/${action.service}: ${result.error.message}`);
        // Continue executing remaining actions for partial completion
        results.push({ entityId: action.entityId, domain: action.domain, service: action.service, success: false });
        continue;
      }
      results.push(result.value);
    }

    if (failures.length === scene.actions.length) {
      // All actions failed
      return Err(
        createError(ErrorCode.HA_SERVICE_FAILED, `All ${failures.length} action(s) failed in scene "${scene.name}"`),
      );
    }

    // Update last_executed_at
    try {
      const now = Date.now();
      this.db.query("UPDATE ha_scenes SET last_executed_at = ? WHERE id = ?").run(now, id);
    } catch {
      // Non-fatal: the execution itself succeeded
      this.logger.warn("executeScene", `Failed to update last_executed_at for scene: ${id}`);
    }

    this.eventBus.publish(
      "ha:scene_executed",
      {
        sceneId: scene.id,
        sceneName: scene.name,
        actionCount: scene.actions.length,
        results,
      },
      { source: "ha-scenes", priority: "normal" },
    );

    this.logger.info("executeScene", `Executed scene: ${scene.name} (${results.length} actions)`);
    return Ok(results);
  }

  /** Delete a scene by ID. */
  deleteScene(id: string): Result<void, EidolonError> {
    try {
      const existing = this.db.query("SELECT id FROM ha_scenes WHERE id = ?").get(id) as { id: string } | null;

      if (!existing) {
        return Err(createError(ErrorCode.HA_SCENE_NOT_FOUND, `Scene not found: ${id}`));
      }

      this.db.query("DELETE FROM ha_scenes WHERE id = ?").run(id);
      this.logger.info("deleteScene", `Deleted scene: ${id}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete scene: ${id}`, cause));
    }
  }

  /** Update a scene's name and/or actions. */
  updateScene(
    id: string,
    updates: { name?: string; actions?: readonly HASceneAction[] },
  ): Result<HAScene, EidolonError> {
    // Validate inputs before entering the transaction
    const trimmedName = updates.name?.trim();
    if (updates.name !== undefined && (trimmedName === undefined || trimmedName.length === 0)) {
      return Err(createError(ErrorCode.INVALID_INPUT, "Scene name must not be empty"));
    }

    if (updates.actions !== undefined && updates.actions.length > MAX_ACTIONS_PER_SCENE) {
      return Err(
        createError(
          ErrorCode.INVALID_INPUT,
          `Too many actions (${updates.actions.length}, max ${MAX_ACTIONS_PER_SCENE})`,
        ),
      );
    }

    try {
      // Wrap name uniqueness check + UPDATE in a transaction to prevent TOCTOU races
      // (same pattern as createScene which already uses a transaction).
      const updateSceneTx = this.db.transaction(() => {
        const existing = this.db.query("SELECT * FROM ha_scenes WHERE id = ?").get(id) as HASceneRow | null;

        if (!existing) {
          throw new Error(`NOTFOUND:Scene not found: ${id}`);
        }

        const newName = trimmedName ?? existing.name;
        const newActions = updates.actions ?? parseActions(existing.actions);

        // Check name uniqueness if changing name
        if (newName !== existing.name) {
          const duplicate = this.db.query("SELECT id FROM ha_scenes WHERE name = ? AND id != ?").get(newName, id) as {
            id: string;
          } | null;
          if (duplicate) {
            throw new Error(`DUPLICATE:Scene with name "${newName}" already exists`);
          }
        }

        const actionsJson = JSON.stringify(newActions);
        this.db.query("UPDATE ha_scenes SET name = ?, actions = ? WHERE id = ?").run(newName, actionsJson, id);

        return {
          id,
          name: newName,
          actions: newActions,
          createdAt: existing.created_at,
          lastExecutedAt: existing.last_executed_at ?? undefined,
        } satisfies HAScene;
      });

      let updated: HAScene;
      try {
        updated = updateSceneTx();
      } catch (txErr: unknown) {
        const msg = txErr instanceof Error ? txErr.message : String(txErr);
        if (msg.startsWith("NOTFOUND:")) {
          return Err(createError(ErrorCode.HA_SCENE_NOT_FOUND, msg.slice(msg.indexOf(":") + 1)));
        }
        if (msg.startsWith("DUPLICATE:")) {
          return Err(createError(ErrorCode.INVALID_INPUT, msg.slice(msg.indexOf(":") + 1)));
        }
        throw txErr;
      }

      this.logger.info("updateScene", `Updated scene: ${updated.name}`);
      return Ok(updated);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update scene: ${id}`, cause));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseActions(json: string): HASceneAction[] {
  try {
    const parsed: unknown = JSON.parse(json);
    const result = SceneActionsArraySchema.safeParse(parsed);
    if (!result.success) return [];
    return result.data;
  } catch {
    // Intentional: malformed JSON actions default to empty array
    return [];
  }
}

function rowToScene(row: HASceneRow): HAScene {
  return {
    id: row.id,
    name: row.name,
    actions: parseActions(row.actions),
    createdAt: row.created_at,
    lastExecutedAt: row.last_executed_at ?? undefined,
  };
}
