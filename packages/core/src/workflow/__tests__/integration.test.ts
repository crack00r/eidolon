/**
 * Integration tests for workflow engine.
 *
 * Tests end-to-end workflow execution with multiple steps, condition branching,
 * and crash recovery scenarios.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Err, createError, ErrorCode, Ok } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { WorkflowEngine } from "../engine.ts";
import { StepExecutorRegistry } from "../executor-registry.ts";
import { ConditionStepExecutor } from "../executors/condition.ts";
import { TransformStepExecutor } from "../executors/transform.ts";
import { WaitStepExecutor } from "../executors/wait.ts";
import { WorkflowStore } from "../store.ts";
import type {
  IStepExecutor,
  StepConfig,
  StepOutput,
  WorkflowContext,
  WorkflowDefinition,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error("Failed to run migrations");
  return db;
}

class ConfigurableExecutor implements IStepExecutor {
  readonly type;
  private resultFn: (config: StepConfig, ctx: WorkflowContext) => Promise<Result<StepOutput, EidolonError>>;

  constructor(
    type: IStepExecutor["type"],
    resultFn?: (config: StepConfig, ctx: WorkflowContext) => Promise<Result<StepOutput, EidolonError>>,
  ) {
    this.type = type;
    this.resultFn = resultFn ?? (async () => Ok({ data: "default", tokensUsed: 5 }));
  }

  async execute(
    config: StepConfig,
    context: WorkflowContext,
    _signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    return this.resultFn(config, context);
  }
}

interface TestHarness {
  engine: WorkflowEngine;
  store: WorkflowStore;
  registry: StepExecutorRegistry;
  eventBus: EventBus;
  db: Database;
}

function createHarness(
  executorOverrides?: Record<string, ConfigurableExecutor>,
): TestHarness {
  const db = createTestDb();
  const logger = createSilentLogger();
  const store = new WorkflowStore(db, logger);
  const registry = new StepExecutorRegistry();
  const eventBus = new EventBus(db, logger);

  // Register defaults
  const defaultTypes = ["llm_call", "api_call", "channel_send", "ha_command", "memory_query", "sub_workflow"] as const;
  for (const t of defaultTypes) {
    if (!executorOverrides?.[t]) {
      registry.register(new ConfigurableExecutor(t));
    }
  }
  registry.register(new ConditionStepExecutor());
  registry.register(new TransformStepExecutor());
  registry.register(new WaitStepExecutor());

  // Apply overrides
  if (executorOverrides) {
    for (const exec of Object.values(executorOverrides)) {
      registry.register(exec);
    }
  }

  const engine = new WorkflowEngine(store, registry, eventBus, logger);
  return { engine, store, registry, eventBus, db };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("Workflow Integration", () => {
  const harnesses: TestHarness[] = [];

  function setup(overrides?: Record<string, ConfigurableExecutor>): TestHarness {
    const h = createHarness(overrides);
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

  test("multi-step linear workflow: research -> summarize -> send", async () => {
    const llmExec = new ConfigurableExecutor("llm_call", async (config) => {
      const prompt = (config as Record<string, string>).prompt ?? "";
      if (prompt.includes("Research")) {
        return Ok({ data: "Research findings about Rust features...", tokensUsed: 100 });
      }
      return Ok({ data: "Summary of findings.", tokensUsed: 50 });
    });

    const channelExec = new ConfigurableExecutor("channel_send", async () => {
      return Ok({ data: { sent: true }, tokensUsed: 0 });
    });

    const { engine, store } = setup({
      llm_call: llmExec,
      channel_send: channelExec,
    });

    const def: WorkflowDefinition = {
      id: "wf-research",
      name: "Research and Send",
      description: "Research, summarize, send",
      trigger: { type: "manual" },
      steps: [
        {
          id: "research",
          name: "Research",
          type: "llm_call",
          config: { prompt: "Research Rust features", outputKey: "findings" },
          dependsOn: [],
        },
        {
          id: "summarize",
          name: "Summarize",
          type: "llm_call",
          config: { prompt: "Summarize: {{research.output}}", outputKey: "summary" },
          dependsOn: ["research"],
        },
        {
          id: "send",
          name: "Send",
          type: "channel_send",
          config: { channelId: "telegram", message: "{{summarize.output}}" },
          dependsOn: ["summarize"],
        },
      ],
      onFailure: { type: "abort" },
      createdAt: Date.now(),
      createdBy: "user",
      maxDurationMs: 1800000,
      metadata: {},
    };

    engine.createDefinition(def);
    const startResult = engine.startRun("wf-research");
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const runId = startResult.value.id;

    // Execute step 1: research
    let stepEvent = {
      id: "e1",
      type: "workflow:step_ready" as const,
      priority: "normal" as const,
      payload: { runId, stepId: "research" },
      timestamp: Date.now(),
      source: "test",
    };
    let result = await engine.processEvent(stepEvent);
    expect(result.success).toBe(true);

    // Execute step 2: summarize
    stepEvent = {
      ...stepEvent,
      id: "e2",
      payload: { runId, stepId: "summarize" },
    };
    result = await engine.processEvent(stepEvent);
    expect(result.success).toBe(true);

    // Execute step 3: send
    stepEvent = {
      ...stepEvent,
      id: "e3",
      payload: { runId, stepId: "send" },
    };
    result = await engine.processEvent(stepEvent);
    expect(result.success).toBe(true);

    // Verify completed
    const statusResult = engine.getRunStatus(runId);
    expect(statusResult.ok).toBe(true);
    if (statusResult.ok) {
      expect(statusResult.value.run.status).toBe("completed");
    }
  });

  test("condition branching: then path", async () => {
    const { engine } = setup();

    const def: WorkflowDefinition = {
      id: "wf-cond",
      name: "Conditional",
      description: "Test condition",
      trigger: { type: "manual" },
      steps: [
        {
          id: "check",
          name: "Check",
          type: "condition",
          config: { expression: "trigger.temp < 18", thenSteps: ["heat"], elseSteps: ["cool"] },
          dependsOn: [],
        },
        {
          id: "heat",
          name: "Heat",
          type: "ha_command",
          config: { entityId: "climate.office", action: "turn_on" },
          dependsOn: ["check"],
        },
        {
          id: "cool",
          name: "Cool",
          type: "ha_command",
          config: { entityId: "climate.office", action: "turn_off" },
          dependsOn: ["check"],
        },
      ],
      onFailure: { type: "abort" },
      createdAt: Date.now(),
      createdBy: "user",
      maxDurationMs: 1800000,
      metadata: {},
    };

    engine.createDefinition(def);
    const startResult = engine.startRun("wf-cond", { temp: 15 });
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const runId = startResult.value.id;

    // Execute condition check
    const checkEvent = {
      id: "e1",
      type: "workflow:step_ready" as const,
      priority: "normal" as const,
      payload: { runId, stepId: "check" },
      timestamp: Date.now(),
      source: "test",
    };
    await engine.processEvent(checkEvent);

    // Execute heat (should succeed since temp < 18)
    const heatEvent = {
      ...checkEvent,
      id: "e2",
      payload: { runId, stepId: "heat" },
    };
    const heatResult = await engine.processEvent(heatEvent);
    expect(heatResult.success).toBe(true);
  });

  test("step failure with abort strategy", async () => {
    const failExec = new ConfigurableExecutor("llm_call", async () => {
      return Err(createError(ErrorCode.CLAUDE_PROCESS_CRASHED, "LLM failed"));
    });

    const { engine } = setup({ llm_call: failExec });

    const def: WorkflowDefinition = {
      id: "wf-fail",
      name: "Failing Workflow",
      description: "Test failure",
      trigger: { type: "manual" },
      steps: [
        {
          id: "fail_step",
          name: "Fail",
          type: "llm_call",
          config: { prompt: "fail", outputKey: "r" },
          dependsOn: [],
        },
      ],
      onFailure: { type: "abort" },
      createdAt: Date.now(),
      createdBy: "user",
      maxDurationMs: 1800000,
      metadata: {},
    };

    engine.createDefinition(def);
    const startResult = engine.startRun("wf-fail");
    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;

    const runId = startResult.value.id;

    const event = {
      id: "e1",
      type: "workflow:step_ready" as const,
      priority: "normal" as const,
      payload: { runId, stepId: "fail_step" },
      timestamp: Date.now(),
      source: "test",
    };
    await engine.processEvent(event);

    const statusResult = engine.getRunStatus(runId);
    expect(statusResult.ok).toBe(true);
    if (statusResult.ok) {
      expect(statusResult.value.run.status).toBe("failed");
      expect(statusResult.value.run.error).toContain("LLM failed");
    }
  });

  test("crash recovery re-publishes ready steps", () => {
    const { engine, store } = setup();

    const def: WorkflowDefinition = {
      id: "wf-recover",
      name: "Recovery Test",
      description: "Test crash recovery",
      trigger: { type: "manual" },
      steps: [
        {
          id: "a",
          name: "A",
          type: "llm_call",
          config: { prompt: "hi", outputKey: "r" },
          dependsOn: [],
        },
        {
          id: "b",
          name: "B",
          type: "llm_call",
          config: { prompt: "hi", outputKey: "r" },
          dependsOn: ["a"],
        },
      ],
      onFailure: { type: "abort" },
      createdAt: Date.now(),
      createdBy: "user",
      maxDurationMs: 1800000,
      metadata: {},
    };

    engine.createDefinition(def);
    engine.startRun("wf-recover");

    // Simulate crash and recovery
    const result = engine.recoverRunningWorkflows();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1);
    }
  });
});
