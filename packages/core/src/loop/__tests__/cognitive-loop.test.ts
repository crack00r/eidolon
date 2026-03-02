import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { BusEvent } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import type { EventHandler } from "../cognitive-loop.ts";
import { CognitiveLoop } from "../cognitive-loop.ts";
import type { EnergyBudgetConfig } from "../energy-budget.ts";
import { EnergyBudget } from "../energy-budget.ts";
import { EventBus } from "../event-bus.ts";
import type { PriorityScore } from "../priority.ts";
import { PriorityEvaluator } from "../priority.ts";
import { DEFAULT_REST_CONFIG, RestCalculator } from "../rest.ts";
import { SessionSupervisor } from "../session-supervisor.ts";
import { CognitiveStateMachine } from "../state-machine.ts";

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

const TEST_BUDGET_CONFIG: EnergyBudgetConfig = {
  maxTokensPerHour: 100_000,
  categories: {
    user: 0.5,
    tasks: 0.2,
    learning: 0.2,
    dreaming: 0.1,
  },
};

/** Minimal rest config for fast tests. */
const FAST_REST_CONFIG = {
  ...DEFAULT_REST_CONFIG,
  activeMinMs: 0,
  idleMinMs: 0,
  maxMs: 0,
  nightModeMultiplier: 1,
  nightModeStartHour: 25,
  nightModeEndHour: 25,
};

interface TestHarness {
  loop: CognitiveLoop;
  eventBus: EventBus;
  stateMachine: CognitiveStateMachine;
  energyBudget: EnergyBudget;
  evaluator: PriorityEvaluator;
  restCalculator: RestCalculator;
  supervisor: SessionSupervisor;
  db: Database;
}

function createTestLoop(handler?: EventHandler, skipTransition?: boolean): TestHarness {
  const logger = createSilentLogger();
  const db = createTestDb();
  const eventBus = new EventBus(db, logger);
  const stateMachine = new CognitiveStateMachine(logger);
  const evaluator = new PriorityEvaluator(logger);
  const energyBudget = new EnergyBudget(TEST_BUDGET_CONFIG, logger);
  const restCalculator = new RestCalculator(FAST_REST_CONFIG, logger);
  const supervisor = new SessionSupervisor(logger);

  // Transition to perceiving so runOneCycle can start cleanly (from "starting")
  if (!skipTransition) {
    stateMachine.transition("perceiving");
  }

  const loop = new CognitiveLoop(eventBus, stateMachine, evaluator, energyBudget, restCalculator, supervisor, logger, {
    handler,
  });

  return { loop, eventBus, stateMachine, energyBudget, evaluator, restCalculator, supervisor, db };
}

describe("CognitiveLoop", () => {
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function harness(handler?: EventHandler): TestHarness {
    const h = createTestLoop(handler);
    databases.push(h.db);
    return h;
  }

  test("runOneCycle returns no-event result when queue empty", async () => {
    const { loop } = harness();

    const result = await loop.runOneCycle();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hadEvent).toBe(false);
    expect(result.value.action).toBeNull();
    expect(result.value.tokensUsed).toBe(0);
    expect(result.value.deferred).toBe(false);
  });

  test("runOneCycle processes a user message event", async () => {
    const handlerCalls: { event: BusEvent; priority: PriorityScore }[] = [];
    const { loop, eventBus } = harness(async (event, priority) => {
      handlerCalls.push({ event, priority });
      return { success: true, tokensUsed: 500 };
    });

    eventBus.publish("user:message", { text: "hello" }, { priority: "high", source: "test" });

    const result = await loop.runOneCycle();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hadEvent).toBe(true);
    expect(result.value.action).toBe("respond");
    expect(result.value.tokensUsed).toBe(500);
    expect(result.value.deferred).toBe(false);
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0]?.event.type).toBe("user:message");
  });

  test("runOneCycle defers event when energy budget exhausted", async () => {
    const { loop, eventBus, energyBudget } = harness();

    // Exhaust the learning budget
    energyBudget.consume("learning", 100_000);

    // Publish a learning event (maps to "learn" action -> "learning" budget category)
    eventBus.publish("learning:discovery", { discoveryId: "d1" }, { priority: "normal", source: "test" });

    const result = await loop.runOneCycle();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hadEvent).toBe(true);
    expect(result.value.deferred).toBe(true);
    expect(result.value.action).toBeNull();
    expect(result.value.tokensUsed).toBe(0);
  });

  test("runOneCycle calls handler with event and priority", async () => {
    const received: { event: BusEvent; priority: PriorityScore }[] = [];

    const { loop, eventBus } = harness(async (event, priority) => {
      received.push({ event, priority });
      return { success: true, tokensUsed: 200 };
    });

    eventBus.publish("scheduler:task_due", { taskId: "t1" }, { priority: "normal", source: "test" });

    await loop.runOneCycle();

    expect(received).toHaveLength(1);
    expect(received[0]?.event.type).toBe("scheduler:task_due");
    expect(received[0]?.priority.suggestedAction).toBe("execute_task");
  });

  test("runOneCycle marks event as processed", async () => {
    const { loop, eventBus, db } = harness(async () => {
      return { success: true, tokensUsed: 100 };
    });

    const pubResult = eventBus.publish("user:message", { text: "test" });
    expect(pubResult.ok).toBe(true);
    if (!pubResult.ok) return;

    await loop.runOneCycle();

    // Event should now be processed
    const row = db.query("SELECT processed_at FROM events WHERE id = ?").get(pubResult.value.id) as {
      processed_at: number | null;
    };
    expect(row.processed_at).not.toBeNull();

    // Queue should be empty
    const dequeueResult = eventBus.dequeue();
    expect(dequeueResult.ok).toBe(true);
    if (dequeueResult.ok) {
      expect(dequeueResult.value).toBeNull();
    }
  });

  test("runOneCycle updates statistics", async () => {
    const { loop, eventBus } = harness(async () => {
      return { success: true, tokensUsed: 750 };
    });

    eventBus.publish("user:message", { text: "first" });
    await loop.runOneCycle();

    eventBus.publish("user:message", { text: "second" });
    await loop.runOneCycle();

    const stats = loop.getStats();
    expect(stats.totalCycles).toBe(2);
    expect(stats.eventsProcessed).toBe(2);
    expect(stats.totalTokensUsed).toBe(1500);
    expect(stats.lastCycleAt).not.toBeNull();
  });

  test("runOneCycle transitions through PEAR phases", async () => {
    const phases: string[] = [];
    const logger = createSilentLogger();
    const db = createTestDb();
    databases.push(db);

    const eventBus = new EventBus(db, logger);
    const stateMachine = new CognitiveStateMachine(logger);
    const evaluator = new PriorityEvaluator(logger);
    const energyBudget = new EnergyBudget(TEST_BUDGET_CONFIG, logger);
    const restCalculator = new RestCalculator(FAST_REST_CONFIG, logger);
    const supervisor = new SessionSupervisor(logger);

    // Transition to perceiving first (required for the loop)
    stateMachine.transition("perceiving");

    // Track phase transitions by wrapping the transition method
    const originalTransition = stateMachine.transition.bind(stateMachine);
    stateMachine.transition = (to) => {
      phases.push(to);
      return originalTransition(to);
    };

    const loop = new CognitiveLoop(
      eventBus,
      stateMachine,
      evaluator,
      energyBudget,
      restCalculator,
      supervisor,
      logger,
      {
        handler: async () => ({ success: true, tokensUsed: 100 }),
      },
    );

    eventBus.publish("user:message", { text: "test" });
    await loop.runOneCycle();

    // Should have gone through all PEAR phases: evaluating -> acting -> reflecting
    // (perceiving is skipped because the state machine is already in perceiving)
    expect(phases).toContain("evaluating");
    expect(phases).toContain("acting");
    expect(phases).toContain("reflecting");
    // Verify the order: evaluating comes before acting, acting before reflecting
    const evalIdx = phases.indexOf("evaluating");
    const actIdx = phases.indexOf("acting");
    const reflectIdx = phases.indexOf("reflecting");
    expect(evalIdx).toBeLessThan(actIdx);
    expect(actIdx).toBeLessThan(reflectIdx);
  });

  test("stop() terminates the running loop", async () => {
    // Use skipTransition=true so start() can manage state machine from "starting"
    const h = createTestLoop(async () => ({ success: true, tokensUsed: 100 }), true);
    databases.push(h.db);
    const { loop, eventBus } = h;

    // Publish an event so the first cycle processes something
    eventBus.publish("user:message", { text: "hello" });

    const startPromise = loop.start();
    setTimeout(() => loop.stop(), 100);
    await startPromise;

    expect(loop.running).toBe(false);
    const stats = loop.getStats();
    expect(stats.startedAt).not.toBeNull();
    expect(stats.totalCycles).toBeGreaterThanOrEqual(1);
  });

  test("getStats returns correct statistics", async () => {
    const { loop } = harness();

    // Initially all zeros
    const initial = loop.getStats();
    expect(initial.totalCycles).toBe(0);
    expect(initial.eventsProcessed).toBe(0);
    expect(initial.eventsDeferred).toBe(0);
    expect(initial.totalTokensUsed).toBe(0);
    expect(initial.totalRestMs).toBe(0);
    expect(initial.startedAt).toBeNull();
    expect(initial.lastCycleAt).toBeNull();

    // After an empty cycle
    await loop.runOneCycle();
    const afterEmpty = loop.getStats();
    expect(afterEmpty.totalCycles).toBe(1);
    expect(afterEmpty.eventsProcessed).toBe(0);
    expect(afterEmpty.lastCycleAt).not.toBeNull();
  });

  test("user events always bypass energy budget", async () => {
    const handlerCalls: BusEvent[] = [];
    const { loop, eventBus, energyBudget } = harness(async (event) => {
      handlerCalls.push(event);
      return { success: true, tokensUsed: 100 };
    });

    // Exhaust the user budget
    energyBudget.consume("user", 100_000);

    // User messages should still be processed
    eventBus.publish("user:message", { text: "important" }, { priority: "high", source: "test" });

    const result = await loop.runOneCycle();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hadEvent).toBe(true);
    expect(result.value.deferred).toBe(false);
    expect(result.value.action).toBe("respond");
    expect(handlerCalls).toHaveLength(1);
  });
});
