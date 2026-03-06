/**
 * Tests for HASceneEngine.
 *
 * Verifies scene CRUD operations (create, get, list, update, delete)
 * and scene execution with mock service executors.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { EidolonError, HASceneAction, HAServiceResult, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { EventBus } from "../../loop/event-bus.ts";
import type { ExecuteServiceFn } from "../scenes.ts";
import { HASceneEngine } from "../scenes.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE ha_scenes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      actions TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_executed_at INTEGER
    );
  `);
  return db;
}

function createMockEventBus(): EventBus & { readonly published: Array<{ type: string; payload: unknown }> } {
  const published: Array<{ type: string; payload: unknown }> = [];
  return {
    published,
    publish(type: string, payload: unknown) {
      published.push({ type, payload });
      return Ok({
        id: "evt-1",
        type,
        priority: "normal" as const,
        payload,
        timestamp: Date.now(),
        source: "test",
      });
    },
    subscribe: () => () => {},
    subscribeAll: () => () => {},
    dequeue: () => Ok(null),
    pendingCount: () => Ok(0),
    markProcessed: () => Ok(undefined),
    replayUnprocessed: () => Ok([]),
    pause: () => {},
    resume: () => {},
  } as unknown as EventBus & { readonly published: Array<{ type: string; payload: unknown }> };
}

function makeActions(count: number = 2): HASceneAction[] {
  const actions: HASceneAction[] = [];
  for (let i = 0; i < count; i++) {
    actions.push({
      entityId: `light.room_${i}`,
      domain: "light",
      service: "turn_on",
      data: { brightness: 255 },
    });
  }
  return actions;
}

function makeSuccessExecutor(): ExecuteServiceFn {
  return async (entityId, domain, service): Promise<Result<HAServiceResult, EidolonError>> => {
    return Ok({ entityId, domain, service, success: true });
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HASceneEngine", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeDeps(): { db: Database; eventBus: ReturnType<typeof createMockEventBus> } {
    const db = createTestDb();
    databases.push(db);
    return { db, eventBus: createMockEventBus() };
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  // -------------------------------------------------------------------------
  // createScene
  // -------------------------------------------------------------------------

  describe("createScene", () => {
    test("creates a scene and returns it", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const result = engine.createScene("Movie Night", makeActions());

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("Movie Night");
      expect(result.value.actions.length).toBe(2);
      expect(result.value.id).toBeTruthy();
      expect(result.value.createdAt).toBeGreaterThan(0);
    });

    test("rejects duplicate scene names", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      engine.createScene("Movie Night", makeActions());
      const result = engine.createScene("Movie Night", makeActions(1));

      expect(result.ok).toBe(false);
    });

    test("rejects empty scene names", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const result = engine.createScene("  ", makeActions());

      expect(result.ok).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getScene / listScenes
  // -------------------------------------------------------------------------

  describe("getScene", () => {
    test("retrieves a scene by ID", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Test Scene", makeActions());
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const getResult = engine.getScene(createResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.name).toBe("Test Scene");
    });

    test("returns null for nonexistent scene", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const result = engine.getScene("nonexistent-id");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe("listScenes", () => {
    test("returns all scenes sorted by name", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      engine.createScene("Bedtime", makeActions());
      engine.createScene("Alarm", makeActions());
      engine.createScene("Movie Night", makeActions());

      const result = engine.listScenes();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(3);
      expect(result.value[0]?.name).toBe("Alarm");
      expect(result.value[1]?.name).toBe("Bedtime");
      expect(result.value[2]?.name).toBe("Movie Night");
    });

    test("returns empty array when no scenes exist", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const result = engine.listScenes();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // executeScene
  // -------------------------------------------------------------------------

  describe("executeScene", () => {
    test("runs all actions in a scene", async () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Test Run", makeActions(3));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await engine.executeScene(createResult.value.id, makeSuccessExecutor());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(3);
      expect(result.value[0]?.success).toBe(true);
    });

    test("publishes ha:scene_executed event", async () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Event Test", makeActions());
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await engine.executeScene(createResult.value.id, makeSuccessExecutor());

      const sceneEvents = eventBus.published.filter((e) => e.type === "ha:scene_executed");
      expect(sceneEvents.length).toBe(1);
    });

    test("returns error when scene not found", async () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const result = await engine.executeScene("nonexistent", makeSuccessExecutor());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCode.HA_SCENE_NOT_FOUND);
    });

    test("stops on first action failure", async () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Fail Test", makeActions(3));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      let callCount = 0;
      const failOnSecond: ExecuteServiceFn = async (entityId, domain, service) => {
        callCount++;
        if (callCount === 2) {
          return Err(createError(ErrorCode.HA_SERVICE_FAILED, "Failed"));
        }
        return Ok({ entityId, domain, service, success: true });
      };

      const result = await engine.executeScene(createResult.value.id, failOnSecond);
      expect(result.ok).toBe(false);
      expect(callCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // deleteScene
  // -------------------------------------------------------------------------

  describe("deleteScene", () => {
    test("deletes a scene by ID", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Delete Me", makeActions());
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const deleteResult = engine.deleteScene(createResult.value.id);
      expect(deleteResult.ok).toBe(true);

      const getResult = engine.getScene(createResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toBeNull();
    });

    test("returns error for nonexistent scene", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const result = engine.deleteScene("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCode.HA_SCENE_NOT_FOUND);
    });
  });

  // -------------------------------------------------------------------------
  // updateScene
  // -------------------------------------------------------------------------

  describe("updateScene", () => {
    test("updates scene name", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Old Name", makeActions());
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = engine.updateScene(createResult.value.id, { name: "New Name" });
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;
      expect(updateResult.value.name).toBe("New Name");
    });

    test("updates scene actions", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Action Update", makeActions(2));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const newActions = makeActions(5);
      const updateResult = engine.updateScene(createResult.value.id, { actions: newActions });
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;
      expect(updateResult.value.actions.length).toBe(5);
    });

    test("returns error for nonexistent scene", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const result = engine.updateScene("nonexistent", { name: "New Name" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCode.HA_SCENE_NOT_FOUND);
    });

    test("rejects duplicate name on update", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      engine.createScene("Scene A", makeActions());
      const bResult = engine.createScene("Scene B", makeActions());
      expect(bResult.ok).toBe(true);
      if (!bResult.ok) return;

      const result = engine.updateScene(bResult.value.id, { name: "Scene A" });
      expect(result.ok).toBe(false);
    });

    test("allows updating to same name (no-op rename)", () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Same Name", makeActions());
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = engine.updateScene(createResult.value.id, { name: "Same Name" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("Same Name");
    });
  });

  // -------------------------------------------------------------------------
  // Scene execution updates last_executed_at
  // -------------------------------------------------------------------------

  describe("execution tracking", () => {
    test("updates last_executed_at after successful execution", async () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Track Exec", makeActions());
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Initially no last_executed_at
      const beforeGet = engine.getScene(createResult.value.id);
      expect(beforeGet.ok).toBe(true);
      if (!beforeGet.ok) return;
      expect(beforeGet.value?.lastExecutedAt).toBeUndefined();

      await engine.executeScene(createResult.value.id, makeSuccessExecutor());

      const afterGet = engine.getScene(createResult.value.id);
      expect(afterGet.ok).toBe(true);
      if (!afterGet.ok) return;
      expect(afterGet.value?.lastExecutedAt).toBeGreaterThan(0);
    });

    test("scene execution event includes scene metadata", async () => {
      const { db, eventBus } = makeDeps();
      const engine = new HASceneEngine(db, logger, eventBus);

      const createResult = engine.createScene("Metadata Test", makeActions(2));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      await engine.executeScene(createResult.value.id, makeSuccessExecutor());

      const sceneEvents = eventBus.published.filter((e) => e.type === "ha:scene_executed");
      expect(sceneEvents.length).toBe(1);

      const payload = sceneEvents[0]?.payload as {
        sceneId: string;
        sceneName: string;
        actionCount: number;
      };
      expect(payload.sceneName).toBe("Metadata Test");
      expect(payload.actionCount).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  describe("persistence", () => {
    test("scenes survive re-instantiation of engine", () => {
      const { db, eventBus } = makeDeps();

      const engine1 = new HASceneEngine(db, logger, eventBus);
      const createResult = engine1.createScene("Persistent Scene", makeActions());
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // New engine instance with same DB
      const engine2 = new HASceneEngine(db, logger, eventBus);
      const listResult = engine2.listScenes();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value.length).toBe(1);
      expect(listResult.value[0]?.name).toBe("Persistent Scene");
    });
  });
});
