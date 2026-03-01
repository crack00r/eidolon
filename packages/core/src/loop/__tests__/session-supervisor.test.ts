import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.js";
import { SessionSupervisor } from "../session-supervisor.js";

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

describe("SessionSupervisor", () => {
  const logger = createSilentLogger();

  function makeSupervisor(): SessionSupervisor {
    return new SessionSupervisor(logger);
  }

  test("canStart returns true when under limit", () => {
    const supervisor = makeSupervisor();

    expect(supervisor.canStart("main")).toBe(true);
    expect(supervisor.canStart("task")).toBe(true);
    expect(supervisor.canStart("dream")).toBe(true);
  });

  test("canStart returns false when at limit", () => {
    const supervisor = makeSupervisor();

    supervisor.register("main-1", "main");
    expect(supervisor.canStart("main")).toBe(false);

    // task allows 3 concurrent
    supervisor.register("task-1", "task");
    supervisor.register("task-2", "task");
    supervisor.register("task-3", "task");
    expect(supervisor.canStart("task")).toBe(false);
  });

  test("register stores session slot", () => {
    const supervisor = makeSupervisor();

    const result = supervisor.register("sess-1", "task");
    expect(result.ok).toBe(true);

    const active = supervisor.getActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.sessionId).toBe("sess-1");
    expect(active[0]?.type).toBe("task");
    expect(active[0]?.interruptible).toBe(true);
  });

  test("register rejects when limit exceeded", () => {
    const supervisor = makeSupervisor();

    supervisor.register("main-1", "main");
    const result = supervisor.register("main-2", "main");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SESSION_LIMIT_REACHED");
    }
  });

  test("unregister removes session", () => {
    const supervisor = makeSupervisor();

    supervisor.register("sess-1", "task");
    expect(supervisor.hasActiveSessions()).toBe(true);

    supervisor.unregister("sess-1");
    expect(supervisor.hasActiveSessions()).toBe(false);
    expect(supervisor.getActive()).toHaveLength(0);
  });

  test("findInterruptible returns lower priority session", () => {
    const supervisor = makeSupervisor();

    // Register a dream session (priority 10, interruptible)
    supervisor.register("dream-1", "dream");
    // Register a learning session (priority 30, interruptible)
    supervisor.register("learn-1", "learning");

    // Voice (priority 80) should be able to interrupt dream (lowest priority)
    const candidate = supervisor.findInterruptible("voice");
    expect(candidate).not.toBeNull();
    expect(candidate?.sessionId).toBe("dream-1");
    expect(candidate?.type).toBe("dream");
  });

  test("findInterruptible returns null when no interruptible available", () => {
    const supervisor = makeSupervisor();

    // Register a main session (not interruptible)
    supervisor.register("main-1", "main");

    // Task (priority 60) cannot interrupt main (priority 100, not interruptible)
    const candidate = supervisor.findInterruptible("task");
    expect(candidate).toBeNull();
  });

  test("findInterruptible returns null when all have higher or equal priority", () => {
    const supervisor = makeSupervisor();

    // Register a voice session (priority 80, interruptible)
    supervisor.register("voice-1", "voice");

    // Dream (priority 10) should not be able to interrupt voice (priority 80)
    const candidate = supervisor.findInterruptible("dream");
    expect(candidate).toBeNull();
  });

  test("getActive returns all active sessions", () => {
    const supervisor = makeSupervisor();

    supervisor.register("sess-1", "main");
    supervisor.register("sess-2", "task");
    supervisor.register("sess-3", "dream");

    const active = supervisor.getActive();
    expect(active).toHaveLength(3);

    const ids = active.map((s) => s.sessionId);
    expect(ids).toContain("sess-1");
    expect(ids).toContain("sess-2");
    expect(ids).toContain("sess-3");
  });

  test("getActiveByType filters by type", () => {
    const supervisor = makeSupervisor();

    supervisor.register("task-1", "task");
    supervisor.register("task-2", "task");
    supervisor.register("dream-1", "dream");

    const tasks = supervisor.getActiveByType("task");
    expect(tasks).toHaveLength(2);

    const dreams = supervisor.getActiveByType("dream");
    expect(dreams).toHaveLength(1);

    const mains = supervisor.getActiveByType("main");
    expect(mains).toHaveLength(0);
  });

  test("countByType returns correct count", () => {
    const supervisor = makeSupervisor();

    supervisor.register("task-1", "task");
    supervisor.register("task-2", "task");

    expect(supervisor.countByType("task")).toBe(2);
    expect(supervisor.countByType("main")).toBe(0);
  });

  test("getRule returns correct concurrency rules", () => {
    const supervisor = makeSupervisor();

    const mainRule = supervisor.getRule("main");
    expect(mainRule.maxConcurrent).toBe(1);
    expect(mainRule.interruptible).toBe(false);
    expect(mainRule.priority).toBe(100);

    const taskRule = supervisor.getRule("task");
    expect(taskRule.maxConcurrent).toBe(3);
    expect(taskRule.interruptible).toBe(true);
    expect(taskRule.priority).toBe(60);
  });

  test("unregister is idempotent for unknown session", () => {
    const supervisor = makeSupervisor();

    // Should not throw
    supervisor.unregister("nonexistent");
    expect(supervisor.hasActiveSessions()).toBe(false);
  });
});
