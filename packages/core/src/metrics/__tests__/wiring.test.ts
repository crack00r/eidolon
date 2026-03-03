import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createLogger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { SessionSupervisor } from "../../loop/session-supervisor.ts";
import { MetricsRegistry } from "../prometheus.ts";
import type { MetricsWiringHandle } from "../wiring.ts";
import { recordTokenMetrics, wireMetrics } from "../wiring.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      processed_at INTEGER,
      claimed_at INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  return db;
}

function createTestLogger() {
  return createLogger({
    level: "error",
    format: "json",
    directory: "",
    maxSizeMb: 50,
    maxFiles: 10,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wireMetrics", () => {
  let db: Database;
  let eventBus: EventBus;
  let registry: MetricsRegistry;
  let logger: ReturnType<typeof createTestLogger>;
  let handle: MetricsWiringHandle | undefined;

  beforeEach(() => {
    db = createTestDb();
    logger = createTestLogger();
    eventBus = new EventBus(db, logger);
    registry = new MetricsRegistry();
  });

  afterEach(() => {
    handle?.dispose();
    handle = undefined;
  });

  test("increments eventsProcessed on every event published", () => {
    handle = wireMetrics({ metricsRegistry: registry, eventBus, logger });

    eventBus.publish("system:startup", { reason: "test" }, { source: "test" });
    eventBus.publish("system:shutdown", { reason: "test" }, { source: "test" });
    eventBus.publish("user:message", { text: "hello" }, { source: "test" });

    expect(registry.eventsProcessed.values.get("")).toBe(3);
  });

  test("updates eventQueueDepth on initial wire", () => {
    // Publish some events before wiring to create pending queue
    eventBus.publish("system:startup", {}, { source: "test" });
    eventBus.publish("system:shutdown", {}, { source: "test" });

    handle = wireMetrics({ metricsRegistry: registry, eventBus, logger });

    // The initial gauge update should reflect the 2 pending events
    expect(registry.eventQueueDepth.values.get("")).toBe(2);
  });

  test("updates activeSessions gauge via session supervisor on session events", () => {
    const supervisor = new SessionSupervisor(logger);
    handle = wireMetrics({
      metricsRegistry: registry,
      eventBus,
      logger,
      sessionSupervisor: supervisor,
    });

    // Register a session in the supervisor
    supervisor.register("sess-1", "main");

    // Emit a session:started event to trigger gauge update
    eventBus.publish("session:started", { sessionId: "sess-1" }, { source: "test" });

    expect(registry.activeSessions.values.get("")).toBe(1);

    // Unregister and emit session:completed
    supervisor.unregister("sess-1");
    eventBus.publish("session:completed", { sessionId: "sess-1" }, { source: "test" });

    expect(registry.activeSessions.values.get("")).toBe(0);
  });

  test("updates activeSessions gauge on session:failed", () => {
    const supervisor = new SessionSupervisor(logger);
    handle = wireMetrics({
      metricsRegistry: registry,
      eventBus,
      logger,
      sessionSupervisor: supervisor,
    });

    supervisor.register("sess-fail", "task");
    eventBus.publish("session:started", { sessionId: "sess-fail" }, { source: "test" });
    expect(registry.activeSessions.values.get("")).toBe(1);

    supervisor.unregister("sess-fail");
    eventBus.publish("session:failed", { sessionId: "sess-fail" }, { source: "test" });
    expect(registry.activeSessions.values.get("")).toBe(0);
  });

  test("dispose() stops counting events", () => {
    handle = wireMetrics({ metricsRegistry: registry, eventBus, logger });

    eventBus.publish("system:startup", {}, { source: "test" });
    expect(registry.eventsProcessed.values.get("")).toBe(1);

    handle.dispose();
    handle = undefined;

    eventBus.publish("system:shutdown", {}, { source: "test" });
    // Should still be 1 since we disposed the wiring
    expect(registry.eventsProcessed.values.get("")).toBe(1);
  });

  test("works without sessionSupervisor (gauges stay at 0)", () => {
    handle = wireMetrics({ metricsRegistry: registry, eventBus, logger });

    eventBus.publish("session:started", { sessionId: "x" }, { source: "test" });

    // Without a supervisor, activeSessions gauge stays at default 0
    expect(registry.activeSessions.values.get("")).toBe(0);
  });
});

describe("recordTokenMetrics", () => {
  test("increments tokensUsed per model and costUsd", () => {
    const registry = new MetricsRegistry();

    recordTokenMetrics(registry, {
      sessionId: "sess-1",
      sessionType: "main",
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheWriteTokens: 100,
      costUsd: 0.05,
      timestamp: Date.now(),
    });

    expect(registry.tokensUsed.values.get("claude-sonnet-4-20250514")).toBe(1800);
    expect(registry.costUsd.values.get("")).toBeCloseTo(0.05, 10);
  });

  test("accumulates across multiple recordings", () => {
    const registry = new MetricsRegistry();

    recordTokenMetrics(registry, {
      sessionId: "sess-1",
      sessionType: "main",
      model: "claude-sonnet-4-20250514",
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.02,
      timestamp: Date.now(),
    });

    recordTokenMetrics(registry, {
      sessionId: "sess-2",
      sessionType: "task",
      model: "claude-haiku-3-20250414",
      inputTokens: 300,
      outputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.01,
      timestamp: Date.now(),
    });

    recordTokenMetrics(registry, {
      sessionId: "sess-1",
      sessionType: "main",
      model: "claude-sonnet-4-20250514",
      inputTokens: 1000,
      outputTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.04,
      timestamp: Date.now(),
    });

    expect(registry.tokensUsed.values.get("claude-sonnet-4-20250514")).toBe(2100);
    expect(registry.tokensUsed.values.get("claude-haiku-3-20250414")).toBe(400);
    expect(registry.costUsd.values.get("")).toBeCloseTo(0.07, 10);
  });
});
