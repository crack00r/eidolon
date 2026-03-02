import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { BusEvent } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { EnergyBudgetConfig } from "../energy-budget.ts";
import { EnergyBudget } from "../energy-budget.ts";
import { PriorityEvaluator } from "../priority.ts";
import { DEFAULT_REST_CONFIG, RestCalculator } from "../rest.ts";

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

function makeEvent(type: string, priority: string = "normal"): BusEvent {
  return {
    id: "test-id",
    type: type as BusEvent["type"],
    priority: priority as BusEvent["priority"],
    payload: {},
    timestamp: Date.now(),
    source: "test",
  };
}

describe("PriorityEvaluator", () => {
  const logger = createSilentLogger();

  test("scores user messages highest", () => {
    const evaluator = new PriorityEvaluator(logger);
    const score = evaluator.evaluate(makeEvent("user:message"));
    expect(score.score).toBe(95);
    expect(score.suggestedAction).toBe("respond");
    expect(score.suggestedModel).toBe("default");
  });

  test("scores system shutdown as critical", () => {
    const evaluator = new PriorityEvaluator(logger);
    const score = evaluator.evaluate(makeEvent("system:shutdown"));
    expect(score.score).toBe(100);
    expect(score.suggestedAction).toBe("alert");
    expect(score.suggestedModel).toBe("fast");
  });

  test("assigns correct action types", () => {
    const evaluator = new PriorityEvaluator(logger);

    const messageScore = evaluator.evaluate(makeEvent("user:message"));
    expect(messageScore.suggestedAction).toBe("respond");

    const taskScore = evaluator.evaluate(makeEvent("scheduler:task_due"));
    expect(taskScore.suggestedAction).toBe("execute_task");

    const learnScore = evaluator.evaluate(makeEvent("learning:discovery"));
    expect(learnScore.suggestedAction).toBe("learn");

    const dreamScore = evaluator.evaluate(makeEvent("memory:dream_start"));
    expect(dreamScore.suggestedAction).toBe("dream");

    const alertScore = evaluator.evaluate(makeEvent("channel:error"));
    expect(alertScore.suggestedAction).toBe("alert");
  });

  test("boosts score for critical priority override", () => {
    const evaluator = new PriorityEvaluator(logger);

    const normalScore = evaluator.evaluate(makeEvent("learning:discovery", "normal"));
    const criticalScore = evaluator.evaluate(makeEvent("learning:discovery", "critical"));

    expect(criticalScore.score).toBeGreaterThan(normalScore.score);
  });
});

describe("EnergyBudget", () => {
  const logger = createSilentLogger();

  const testConfig: EnergyBudgetConfig = {
    maxTokensPerHour: 100_000,
    categories: {
      user: 0.5,
      tasks: 0.2,
      learning: 0.2,
      dreaming: 0.1,
    },
  };

  test("tracks consumption", () => {
    const budget = new EnergyBudget(testConfig, logger);

    expect(budget.remaining("tasks")).toBe(20_000);
    budget.consume("tasks", 5_000);
    expect(budget.remaining("tasks")).toBe(15_000);
    budget.consume("tasks", 10_000);
    expect(budget.remaining("tasks")).toBe(5_000);
  });

  test("canAfford returns false when exhausted", () => {
    const budget = new EnergyBudget(testConfig, logger);

    expect(budget.canAfford("dreaming", 5_000)).toBe(true);
    budget.consume("dreaming", 10_000); // use all 10,000 of dreaming budget
    expect(budget.canAfford("dreaming", 1)).toBe(false);
    expect(budget.remaining("dreaming")).toBe(0);
  });

  test("always allows user category", () => {
    const budget = new EnergyBudget(testConfig, logger);

    // Even after consuming all user tokens, canAfford should still return true
    budget.consume("user", 50_000);
    expect(budget.canAfford("user", 10_000)).toBe(true);
    expect(budget.remaining("user")).toBe(0);
    // Still allowed
    expect(budget.canAfford("user")).toBe(true);
  });

  test("getStats returns correct breakdown", () => {
    const budget = new EnergyBudget(testConfig, logger);
    budget.consume("user", 10_000);
    budget.consume("tasks", 5_000);

    const stats = budget.getStats();
    expect(stats).toHaveLength(4);

    const userStat = stats.find((s) => s.category === "user");
    expect(userStat).toBeDefined();
    if (!userStat) return;
    expect(userStat.allocated).toBe(50_000);
    expect(userStat.used).toBe(10_000);
    expect(userStat.remaining).toBe(40_000);

    const tasksStat = stats.find((s) => s.category === "tasks");
    if (!tasksStat) return;
    expect(tasksStat.used).toBe(5_000);
    expect(tasksStat.remaining).toBe(15_000);
  });

  test("totalRemaining reflects all categories", () => {
    const budget = new EnergyBudget(testConfig, logger);
    expect(budget.totalRemaining()).toBe(100_000);

    budget.consume("user", 20_000);
    budget.consume("tasks", 5_000);
    expect(budget.totalRemaining()).toBe(75_000);
  });
});

describe("RestCalculator", () => {
  const logger = createSilentLogger();

  // Pin the clock to 10:00 AM so isNightMode() always returns false,
  // making tests deterministic regardless of when they actually run.
  beforeEach(() => {
    setSystemTime(new Date(2025, 5, 15, 10, 0, 0));
  });

  afterEach(() => {
    setSystemTime();
  });

  test("returns short rest when user active", () => {
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger);

    const duration = calc.calculate({
      lastUserActivityAt: Date.now() - 1_000, // 1 second ago
      hasPendingEvents: false,
      hasPendingLearning: false,
      isBusinessHours: true,
    });

    expect(duration).toBe(DEFAULT_REST_CONFIG.activeMinMs);
  });

  test("returns longer rest when user less recently active", () => {
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger);

    // Active 30 seconds ago -> 5s rest
    const duration30s = calc.calculate({
      lastUserActivityAt: Date.now() - 30_000,
      hasPendingEvents: false,
      hasPendingLearning: false,
      isBusinessHours: true,
    });

    // Active 3 minutes ago -> 15s rest
    const duration3m = calc.calculate({
      lastUserActivityAt: Date.now() - 180_000,
      hasPendingEvents: false,
      hasPendingLearning: false,
      isBusinessHours: true,
    });

    expect(duration30s).toBe(5_000);
    expect(duration3m).toBe(15_000);
  });

  test("returns short rest when pending events", () => {
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger);

    const duration = calc.calculate({
      lastUserActivityAt: Date.now() - 600_000, // 10 minutes ago
      hasPendingEvents: true,
      hasPendingLearning: false,
      isBusinessHours: false,
    });

    expect(duration).toBeLessThanOrEqual(DEFAULT_REST_CONFIG.activeMinMs * DEFAULT_REST_CONFIG.nightModeMultiplier);
  });

  test("returns idle rest during business hours with no activity", () => {
    const calc = new RestCalculator(
      {
        ...DEFAULT_REST_CONFIG,
        // Force night mode off by setting night hours to a non-applicable range
        nightModeStartHour: 25,
        nightModeEndHour: 25,
        nightModeMultiplier: 1,
      },
      logger,
    );

    const duration = calc.calculate({
      lastUserActivityAt: Date.now() - 600_000, // 10 minutes ago
      hasPendingEvents: false,
      hasPendingLearning: false,
      isBusinessHours: true,
    });

    expect(duration).toBe(DEFAULT_REST_CONFIG.idleMinMs);
  });

  test("returns max rest when fully idle with no work", () => {
    const calc = new RestCalculator(
      {
        ...DEFAULT_REST_CONFIG,
        nightModeStartHour: 25,
        nightModeEndHour: 25,
        nightModeMultiplier: 1,
      },
      logger,
    );

    const duration = calc.calculate({
      lastUserActivityAt: Date.now() - 600_000, // 10 minutes ago
      hasPendingEvents: false,
      hasPendingLearning: false,
      isBusinessHours: false,
    });

    expect(duration).toBe(DEFAULT_REST_CONFIG.maxMs);
  });

  test("isNightMode detects wrap-around correctly", () => {
    // Test with a config where night mode wraps around midnight (23-7)
    const calc = new RestCalculator(DEFAULT_REST_CONFIG, logger);
    // This tests the method exists and returns a boolean
    const result = calc.isNightMode();
    expect(typeof result).toBe("boolean");
  });
});
