/**
 * Tests for WorkflowStore CRUD operations.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { WorkflowStore } from "../store.ts";
import type { WorkflowDefinition } from "../types.ts";

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
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error("Failed to run migrations");
  return db;
}

function makeDef(id: string, overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    id,
    name: `Test Workflow ${id}`,
    description: "Test",
    trigger: { type: "manual" },
    steps: [
      {
        id: "step1",
        name: "Step 1",
        type: "llm_call",
        config: { prompt: "Hello", outputKey: "result" },
        dependsOn: [],
      },
    ],
    onFailure: { type: "abort" },
    createdAt: Date.now(),
    createdBy: "user",
    maxDurationMs: 1800000,
    metadata: {},
    ...overrides,
  };
}

describe("WorkflowStore - Definitions", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeStore(): WorkflowStore {
    const db = createTestDb();
    databases.push(db);
    return new WorkflowStore(db, logger);
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  test("creates and retrieves a definition", () => {
    const store = makeStore();
    const def = makeDef("wf-1");

    const result = store.createDefinition(def);
    expect(result.ok).toBe(true);

    const getResult = store.getDefinition("wf-1");
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.id).toBe("wf-1");
      expect(getResult.value.name).toBe("Test Workflow wf-1");
      expect(getResult.value.steps).toHaveLength(1);
    }
  });

  test("returns error for duplicate ID", () => {
    const store = makeStore();
    store.createDefinition(makeDef("wf-1"));
    const result = store.createDefinition(makeDef("wf-1"));
    expect(result.ok).toBe(false);
  });

  test("lists enabled definitions", () => {
    const store = makeStore();
    store.createDefinition(makeDef("wf-1"));
    store.createDefinition(makeDef("wf-2"));

    const result = store.listDefinitions();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  test("deletes a definition", () => {
    const store = makeStore();
    store.createDefinition(makeDef("wf-1"));

    const delResult = store.deleteDefinition("wf-1");
    expect(delResult.ok).toBe(true);

    const getResult = store.getDefinition("wf-1");
    expect(getResult.ok).toBe(false);
  });

  test("returns error for non-existent definition", () => {
    const store = makeStore();
    const result = store.getDefinition("nonexistent");
    expect(result.ok).toBe(false);
  });

  test("rejects invalid definition", () => {
    const store = makeStore();
    const invalid = { ...makeDef("wf-1"), steps: [] };
    const result = store.createDefinition(invalid as WorkflowDefinition);
    expect(result.ok).toBe(false);
  });
});

describe("WorkflowStore - Runs", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeStoreWithDef(): { store: WorkflowStore; defId: string } {
    const db = createTestDb();
    databases.push(db);
    const store = new WorkflowStore(db, logger);
    const def = makeDef("wf-1");
    store.createDefinition(def);
    return { store, defId: "wf-1" };
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  test("creates and retrieves a run", () => {
    const { store, defId } = makeStoreWithDef();

    const result = store.createRun("run-1", defId, { key: "value" });
    expect(result.ok).toBe(true);

    const getResult = store.getRun("run-1");
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.status).toBe("pending");
      expect(getResult.value.definitionId).toBe(defId);
    }
  });

  test("updates run status", () => {
    const { store, defId } = makeStoreWithDef();
    store.createRun("run-1", defId, {});

    const updateResult = store.updateRunStatus("run-1", "running");
    expect(updateResult.ok).toBe(true);

    const getResult = store.getRun("run-1");
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.status).toBe("running");
      expect(getResult.value.startedAt).not.toBeNull();
    }
  });

  test("updates run to completed", () => {
    const { store, defId } = makeStoreWithDef();
    store.createRun("run-1", defId, {});
    store.updateRunStatus("run-1", "running");
    store.updateRunStatus("run-1", "completed");

    const getResult = store.getRun("run-1");
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.status).toBe("completed");
      expect(getResult.value.completedAt).not.toBeNull();
    }
  });

  test("queries runs by status", () => {
    const { store, defId } = makeStoreWithDef();
    store.createRun("run-1", defId, {});
    store.createRun("run-2", defId, {});
    store.updateRunStatus("run-1", "running");

    const runningResult = store.getRunsByStatus("running");
    expect(runningResult.ok).toBe(true);
    if (runningResult.ok) {
      expect(runningResult.value).toHaveLength(1);
      expect(runningResult.value[0]?.id).toBe("run-1");
    }
  });

  test("counts active runs", () => {
    const { store, defId } = makeStoreWithDef();
    store.createRun("run-1", defId, {});
    store.createRun("run-2", defId, {});
    store.updateRunStatus("run-1", "running");

    const countResult = store.countActiveRuns();
    expect(countResult.ok).toBe(true);
    if (countResult.ok) {
      expect(countResult.value).toBe(2); // pending + running
    }
  });
});

describe("WorkflowStore - Step Results", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeStoreWithRun(): { store: WorkflowStore } {
    const db = createTestDb();
    databases.push(db);
    const store = new WorkflowStore(db, logger);
    store.createDefinition(makeDef("wf-1"));
    store.createRun("run-1", "wf-1", {});
    return { store };
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  test("creates and retrieves step results", () => {
    const { store } = makeStoreWithRun();

    store.createStepResult({
      id: "sr-1",
      runId: "run-1",
      stepId: "step1",
      status: "pending",
      output: null,
      error: null,
      attempt: 1,
      startedAt: null,
      completedAt: null,
      tokensUsed: 0,
    });

    const results = store.getStepResults("run-1");
    expect(results.ok).toBe(true);
    if (results.ok) {
      expect(results.value).toHaveLength(1);
      expect(results.value[0]?.stepId).toBe("step1");
    }
  });

  test("updates step result status and output", () => {
    const { store } = makeStoreWithRun();

    store.createStepResult({
      id: "sr-1",
      runId: "run-1",
      stepId: "step1",
      status: "pending",
      output: null,
      error: null,
      attempt: 1,
      startedAt: Date.now(),
      completedAt: null,
      tokensUsed: 0,
    });

    store.updateStepResult("sr-1", {
      status: "completed",
      output: "Step result data",
      tokensUsed: 100,
    });

    const result = store.getStepResult("run-1", "step1");
    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      expect(result.value.status).toBe("completed");
      expect(result.value.output).toBe("Step result data");
      expect(result.value.tokensUsed).toBe(100);
    }
  });

  test("returns null for non-existent step result", () => {
    const { store } = makeStoreWithRun();

    const result = store.getStepResult("run-1", "nonexistent");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });
});
