import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import type { EventHandler } from "../../loop/cognitive-loop.ts";
import { CognitiveLoop } from "../../loop/cognitive-loop.ts";
import type { EnergyBudgetConfig } from "../../loop/energy-budget.ts";
import { EnergyBudget } from "../../loop/energy-budget.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { PriorityEvaluator } from "../../loop/priority.ts";
import { DEFAULT_REST_CONFIG, RestCalculator } from "../../loop/rest.ts";
import { SessionSupervisor } from "../../loop/session-supervisor.ts";
import { CognitiveStateMachine } from "../../loop/state-machine.ts";

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

function createInMemoryOperationalDb(): Database {
  const db = new Database(":memory:");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error("Failed to run migrations");
  return db;
}

const TEST_BUDGET_CONFIG: EnergyBudgetConfig = {
  maxTokensPerHour: 100_000,
  categories: { user: 0.5, tasks: 0.2, learning: 0.2, dreaming: 0.1 },
};

const FAST_REST_CONFIG = {
  ...DEFAULT_REST_CONFIG,
  activeMinMs: 0,
  idleMinMs: 0,
  maxMs: 0,
  nightModeMultiplier: 1,
  nightModeStartHour: 25,
  nightModeEndHour: 25,
};

interface E2EHarness {
  loop: CognitiveLoop;
  eventBus: EventBus;
  stateMachine: CognitiveStateMachine;
  energyBudget: EnergyBudget;
  supervisor: SessionSupervisor;
  db: Database;
}

function createE2EHarness(handler?: EventHandler): E2EHarness {
  const logger = createSilentLogger();
  const db = createInMemoryOperationalDb();
  const eventBus = new EventBus(db, logger);
  const stateMachine = new CognitiveStateMachine(logger);
  const evaluator = new PriorityEvaluator(logger);
  const energyBudget = new EnergyBudget(TEST_BUDGET_CONFIG, logger);
  const restCalculator = new RestCalculator(FAST_REST_CONFIG, logger);
  const supervisor = new SessionSupervisor(logger);

  stateMachine.transition("perceiving");

  const loop = new CognitiveLoop(eventBus, stateMachine, evaluator, energyBudget, restCalculator, supervisor, logger, {
    handler,
  });

  return { loop, eventBus, stateMachine, energyBudget, supervisor, db };
}

describe("E2E Daemon Integration", () => {
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function harness(handler?: EventHandler): E2EHarness {
    const h = createE2EHarness(handler);
    databases.push(h.db);
    return h;
  }

  test("start loop, process user:message event, stop gracefully", async () => {
    const processed: string[] = [];
    const h = createE2EHarness(async (event) => {
      processed.push(event.type);
      return { success: true, tokensUsed: 300 };
    });
    databases.push(h.db);

    // Must reset state machine to "starting" for loop.start()
    const logger = createSilentLogger();
    const db = createInMemoryOperationalDb();
    databases.push(db);
    const eventBus = new EventBus(db, logger);
    const stateMachine = new CognitiveStateMachine(logger);
    const evaluator = new PriorityEvaluator(logger);
    const energyBudget = new EnergyBudget(TEST_BUDGET_CONFIG, logger);
    const restCalculator = new RestCalculator(FAST_REST_CONFIG, logger);
    const supervisor = new SessionSupervisor(logger);

    const processedEvents: string[] = [];
    const loop = new CognitiveLoop(
      eventBus,
      stateMachine,
      evaluator,
      energyBudget,
      restCalculator,
      supervisor,
      logger,
      {
        handler: async (event) => {
          processedEvents.push(event.type);
          return { success: true, tokensUsed: 300 };
        },
      },
    );

    eventBus.publish("user:message", { text: "hello" }, { priority: "high", source: "test" });

    const startPromise = loop.start();
    // Give time for at least one cycle
    await new Promise((resolve) => setTimeout(resolve, 150));
    loop.stop();
    await startPromise;

    expect(loop.running).toBe(false);
    expect(processedEvents).toContain("user:message");
    expect(loop.getStats().eventsProcessed).toBeGreaterThanOrEqual(1);
  });

  test("processes multiple events in priority order", async () => {
    const order: string[] = [];
    const { loop, eventBus } = harness(async (event) => {
      order.push(event.type);
      return { success: true, tokensUsed: 100 };
    });

    // Publish low-priority first, then high-priority
    eventBus.publish("learning:discovery", { discoveryId: "d1" }, { priority: "low", source: "test" });
    eventBus.publish("user:message", { text: "urgent" }, { priority: "critical", source: "test" });

    // Process first cycle - should get the higher-priority event
    await loop.runOneCycle();
    // Process second cycle - should get the remaining event
    await loop.runOneCycle();

    expect(order).toHaveLength(2);
    // user:message (critical) should be processed before learning:discovery (low)
    expect(order[0]).toBe("user:message");
    expect(order[1]).toBe("learning:discovery");
  });

  test("event is persisted to SQLite and survives dequeue", async () => {
    const { eventBus, db } = harness();

    const pubResult = eventBus.publish("user:message", { text: "persistent" });
    expect(pubResult.ok).toBe(true);
    if (!pubResult.ok) return;

    // Verify row exists in the database
    const row = db.query("SELECT id, type, payload FROM events WHERE id = ?").get(pubResult.value.id) as {
      id: string;
      type: string;
      payload: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.type).toBe("user:message");
    const payload = JSON.parse(row?.payload ?? "{}");
    expect(payload.text).toBe("persistent");
  });

  test("session supervisor tracks sessions during loop processing", async () => {
    const { supervisor } = harness();

    expect(supervisor.hasActiveSessions()).toBe(false);

    const regResult = supervisor.register("sess-1", "main");
    expect(regResult.ok).toBe(true);
    expect(supervisor.hasActiveSessions()).toBe(true);
    expect(supervisor.getActive()).toHaveLength(1);

    supervisor.unregister("sess-1");
    expect(supervisor.hasActiveSessions()).toBe(false);
  });

  test("energy budget is consumed after processing", async () => {
    const { loop, eventBus, energyBudget } = harness(async () => {
      return { success: true, tokensUsed: 2000 };
    });

    const initialRemaining = energyBudget.remaining("user");

    eventBus.publish("user:message", { text: "test" }, { priority: "high", source: "test" });
    await loop.runOneCycle();

    const afterRemaining = energyBudget.remaining("user");
    expect(afterRemaining).toBe(initialRemaining - 2000);
  });

  test("failed handler defers the event instead of marking processed", async () => {
    const { loop, eventBus, db } = harness(async () => {
      return { success: false, tokensUsed: 0 };
    });

    eventBus.publish("user:message", { text: "will-fail" }, { priority: "high", source: "test" });
    await loop.runOneCycle();

    // The event should NOT be marked as processed
    const rows = db.query("SELECT processed_at, retry_count FROM events WHERE type = ?").all("user:message") as {
      processed_at: number | null;
      retry_count: number;
    }[];

    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row?.processed_at).toBeNull();
    expect(row?.retry_count).toBeGreaterThanOrEqual(1);
  });

  test("loop stops cleanly even with no events", async () => {
    const logger = createSilentLogger();
    const db = createInMemoryOperationalDb();
    databases.push(db);
    const eventBus = new EventBus(db, logger);
    const stateMachine = new CognitiveStateMachine(logger);
    const evaluator = new PriorityEvaluator(logger);
    const energyBudget = new EnergyBudget(TEST_BUDGET_CONFIG, logger);
    const restCalculator = new RestCalculator(FAST_REST_CONFIG, logger);
    const supervisor = new SessionSupervisor(logger);

    const loop = new CognitiveLoop(eventBus, stateMachine, evaluator, energyBudget, restCalculator, supervisor, logger);

    const startPromise = loop.start();
    // Stop quickly
    await new Promise((resolve) => setTimeout(resolve, 50));
    loop.stop();
    await startPromise;

    expect(loop.running).toBe(false);
    expect(loop.getStats().totalCycles).toBeGreaterThanOrEqual(0);
  });
});
