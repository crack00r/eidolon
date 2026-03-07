/**
 * Tests for WorkflowEngine.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { WorkflowEngine } from "../engine.ts";
import { StepExecutorRegistry } from "../executor-registry.ts";
import { WorkflowStore } from "../store.ts";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext, WorkflowDefinition } from "../types.ts";

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
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error("Failed to run migrations");
  return db;
}

class FakeStepExecutor implements IStepExecutor {
  readonly type;
  readonly calls: Array<{ config: StepConfig; context: WorkflowContext }> = [];
  private result: Result<StepOutput, EidolonError>;

  constructor(type: IStepExecutor["type"], result?: Result<StepOutput, EidolonError>) {
    this.type = type;
    this.result = result ?? Ok({ data: "fake output", tokensUsed: 10 });
  }

  setResult(result: Result<StepOutput, EidolonError>): void {
    this.result = result;
  }

  async execute(
    config: StepConfig,
    context: WorkflowContext,
    _signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    this.calls.push({ config, context });
    return this.result;
  }
}

function makeDef(id: string, steps: WorkflowDefinition["steps"]): WorkflowDefinition {
  return {
    id,
    name: `Workflow ${id}`,
    description: "Test workflow",
    trigger: { type: "manual" },
    steps,
    onFailure: { type: "abort" },
    createdAt: Date.now(),
    createdBy: "user",
    maxDurationMs: 1800000,
    metadata: {},
  };
}

interface TestHarness {
  engine: WorkflowEngine;
  store: WorkflowStore;
  registry: StepExecutorRegistry;
  eventBus: EventBus;
  db: Database;
}

function createHarness(): TestHarness {
  const db = createTestDb();
  const logger = createSilentLogger();
  const store = new WorkflowStore(db, logger);
  const registry = new StepExecutorRegistry();
  const eventBus = new EventBus(db, logger);

  // Register fake executors for all step types
  const types = [
    "llm_call",
    "api_call",
    "channel_send",
    "wait",
    "condition",
    "transform",
    "ha_command",
    "memory_query",
    "sub_workflow",
  ] as const;
  for (const t of types) {
    registry.register(new FakeStepExecutor(t));
  }

  const engine = new WorkflowEngine(store, registry, eventBus, logger);
  return { engine, store, registry, eventBus, db };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkflowEngine", () => {
  const harnesses: TestHarness[] = [];

  function setup(): TestHarness {
    const h = createHarness();
    harnesses.push(h);
    return h;
  }

  afterEach(() => {
    for (const h of harnesses) {
      h.eventBus.dispose();
      h.db.close();
    }
    harnesses.length = 0;
  });

  test("creates a definition with DAG validation", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
      { id: "b", name: "B", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: ["a"] },
    ]);

    const result = engine.createDefinition(def);
    expect(result.ok).toBe(true);
  });

  test("rejects DAG with cycle", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: ["b"] },
      { id: "b", name: "B", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: ["a"] },
    ]);

    const result = engine.createDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("cycle");
    }
  });

  test("rejects DAG with unknown dependency", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: ["nonexistent"] },
    ]);

    const result = engine.createDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("unknown step");
    }
  });

  test("rejects duplicate step IDs", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
      { id: "a", name: "A2", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
    ]);

    const result = engine.createDefinition(def);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Duplicate");
    }
  });

  test("starts a run and transitions to running", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
    ]);
    engine.createDefinition(def);

    const result = engine.startRun("wf-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe("running");
    }
  });

  test("returns error when starting run for nonexistent definition", () => {
    const { engine } = setup();
    const result = engine.startRun("nonexistent");
    expect(result.ok).toBe(false);
  });

  test("enforces concurrent workflow limit", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [{ id: "a", name: "A", type: "wait", config: { durationMs: 60000 }, dependsOn: [] }]);
    engine.createDefinition(def);

    // Start 5 runs (max limit)
    for (let i = 0; i < 5; i++) {
      const result = engine.startRun("wf-1");
      expect(result.ok).toBe(true);
    }

    // 6th should fail
    const result = engine.startRun("wf-1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("concurrent");
    }
  });

  test("cancels a running workflow", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
    ]);
    engine.createDefinition(def);

    const startResult = engine.startRun("wf-1");
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const cancelResult = engine.cancelRun(startResult.value.id);
    expect(cancelResult.ok).toBe(true);

    const statusResult = engine.getRunStatus(startResult.value.id);
    expect(statusResult.ok).toBe(true);
    if (statusResult.ok) {
      expect(statusResult.value.run.status).toBe("cancelled");
    }
  });

  test("handles workflow:trigger event", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
    ]);
    engine.createDefinition(def);

    const event = {
      id: "evt-1",
      type: "workflow:trigger" as const,
      priority: "normal" as const,
      payload: { definitionId: "wf-1" },
      timestamp: Date.now(),
      source: "test",
    };

    const result = engine.processEvent(event);
    expect(result).resolves.toEqual({ success: true, tokensUsed: 0 });
  });

  test("handles workflow:step_ready event and executes step", async () => {
    const { engine, registry } = setup();
    const fakeExec = new FakeStepExecutor("llm_call");
    registry.register(fakeExec);

    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
    ]);
    engine.createDefinition(def);

    const startResult = engine.startRun("wf-1");
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const runId = startResult.value.id;

    const event = {
      id: "evt-1",
      type: "workflow:step_ready" as const,
      priority: "normal" as const,
      payload: { runId, stepId: "a" },
      timestamp: Date.now(),
      source: "test",
    };

    const result = await engine.processEvent(event);
    expect(result.success).toBe(true);

    // Verify step was executed
    expect(fakeExec.calls.length).toBeGreaterThanOrEqual(1);
  });

  test("getRunStatus returns full status", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
    ]);
    engine.createDefinition(def);
    const startResult = engine.startRun("wf-1");
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const statusResult = engine.getRunStatus(startResult.value.id);
    expect(statusResult.ok).toBe(true);
    if (statusResult.ok) {
      expect(statusResult.value.definition.id).toBe("wf-1");
      expect(statusResult.value.steps).toBeDefined();
    }
  });

  test("recovers running workflows", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
    ]);
    engine.createDefinition(def);
    engine.startRun("wf-1");

    const result = engine.recoverRunningWorkflows();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeGreaterThanOrEqual(1);
    }
  });

  test("cancelAllActive cancels running workflows", () => {
    const { engine } = setup();
    const def = makeDef("wf-1", [
      { id: "a", name: "A", type: "llm_call", config: { prompt: "hi", outputKey: "r" }, dependsOn: [] },
    ]);
    engine.createDefinition(def);
    const startResult = engine.startRun("wf-1");
    expect(startResult.ok).toBe(true);

    engine.cancelAllActive();

    if (startResult.ok) {
      const statusResult = engine.getRunStatus(startResult.value.id);
      expect(statusResult.ok).toBe(true);
      if (statusResult.ok) {
        expect(statusResult.value.run.status).toBe("cancelled");
      }
    }
  });
});
