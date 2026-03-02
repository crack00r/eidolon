/**
 * Integration tests for daemon resilience: EventBus crash recovery, stress,
 * subscriber filtering, and CircuitBreaker state transitions.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BusEvent, CircuitBreakerConfig } from "@eidolon/protocol";
import { createTestDatabaseDir, type TestDatabaseDir } from "@eidolon/test-utils";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import { CircuitBreaker } from "../../health/circuit-breaker.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";

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

const logger = createSilentLogger();

// ---------------------------------------------------------------------------
// EventBus integration tests (file-backed SQLite)
// ---------------------------------------------------------------------------

describe("EventBus crash recovery", () => {
  let testDir: TestDatabaseDir;

  beforeEach(() => {
    testDir = createTestDatabaseDir("daemon-resilience-");
  });

  afterEach(() => {
    testDir.cleanup();
  });

  function openDb(): Database {
    const db = new Database(testDir.operationalPath);
    const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger);
    if (!result.ok) throw new Error("Migration failed");
    return db;
  }

  test("replays unprocessed events after restart", () => {
    // --- first instance: publish 3 events, process only 1 ---
    const db1 = openDb();
    const bus1 = new EventBus(db1, logger);

    const pub1 = bus1.publish("user:message", { text: "msg-1" });
    const pub2 = bus1.publish("user:message", { text: "msg-2" });
    const pub3 = bus1.publish("user:message", { text: "msg-3" });
    expect(pub1.ok).toBe(true);
    expect(pub2.ok).toBe(true);
    expect(pub3.ok).toBe(true);

    // Process only the first event via dequeue + markProcessed
    const deq = bus1.dequeue();
    expect(deq.ok).toBe(true);
    if (deq.ok && deq.value) {
      bus1.markProcessed(deq.value.id);
    }

    // Verify 2 still pending
    const pending = bus1.pendingCount();
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(pending.value).toBe(2);

    // Simulate crash: close database
    db1.close();

    // --- second instance: reopen same file, replay ---
    const db2 = openDb();
    const bus2 = new EventBus(db2, logger);

    const replayed: BusEvent[] = [];
    bus2.subscribe("user:message", (event) => {
      replayed.push(event);
    });

    const replayResult = bus2.replayUnprocessed();
    expect(replayResult.ok).toBe(true);
    if (!replayResult.ok) return;

    // replayUnprocessed returns the events and also marks them processed
    expect(replayResult.value).toHaveLength(2);

    // Subscriber should have been notified for each replayed event
    expect(replayed).toHaveLength(2);

    const texts = replayed.map((e) => (e.payload as { text: string }).text);
    expect(texts).toContain("msg-2");
    expect(texts).toContain("msg-3");

    // After replay, pendingCount should be 0
    const after = bus2.pendingCount();
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.value).toBe(0);

    db2.close();
  });
});

describe("EventBus stress test", () => {
  let testDir: TestDatabaseDir;

  beforeEach(() => {
    testDir = createTestDatabaseDir("daemon-stress-");
  });

  afterEach(() => {
    testDir.cleanup();
  });

  test("handles rapid publish of 100 events without data loss", () => {
    const db = new Database(testDir.operationalPath);
    const migResult = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger);
    if (!migResult.ok) throw new Error("Migration failed");

    const bus = new EventBus(db, logger);
    const eventCount = 100;

    // Rapidly publish 100 events
    for (let i = 0; i < eventCount; i++) {
      const result = bus.publish("user:message", { index: i });
      expect(result.ok).toBe(true);
    }

    // Verify all 100 are pending
    const pending = bus.pendingCount();
    expect(pending.ok).toBe(true);
    if (pending.ok) expect(pending.value).toBe(eventCount);

    // Dequeue all 100 and verify none are lost
    const dequeued: BusEvent[] = [];
    for (let i = 0; i < eventCount; i++) {
      const deq = bus.dequeue();
      expect(deq.ok).toBe(true);
      if (deq.ok && deq.value) {
        dequeued.push(deq.value);
        bus.markProcessed(deq.value.id);
      }
    }

    expect(dequeued).toHaveLength(eventCount);

    // Verify each index is present exactly once
    const indices = new Set(dequeued.map((e) => (e.payload as { index: number }).index));
    expect(indices.size).toBe(eventCount);
    for (let i = 0; i < eventCount; i++) {
      expect(indices.has(i)).toBe(true);
    }

    // Nothing left to dequeue
    const empty = bus.dequeue();
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.value).toBeNull();

    db.close();
  });
});

describe("EventBus subscriber filtering", () => {
  let testDir: TestDatabaseDir;

  beforeEach(() => {
    testDir = createTestDatabaseDir("daemon-filter-");
  });

  afterEach(() => {
    testDir.cleanup();
  });

  test("subscriber receives events only for subscribed type", () => {
    const db = new Database(testDir.operationalPath);
    const migResult = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger);
    if (!migResult.ok) throw new Error("Migration failed");

    const bus = new EventBus(db, logger);

    const userMessages: BusEvent[] = [];
    bus.subscribe("user:message", (event) => {
      userMessages.push(event);
    });

    // Publish events of different types
    const r1 = bus.publish("user:message", { text: "hello" });
    const r2 = bus.publish("system:health_check", { status: "ok" });
    const r3 = bus.publish("user:message", { text: "world" });
    const r4 = bus.publish("system:startup", { pid: 1234 });

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    expect(r4.ok).toBe(true);

    // Subscriber should only have received user:message events
    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]?.type).toBe("user:message");
    expect(userMessages[1]?.type).toBe("user:message");
    expect((userMessages[0]?.payload as { text: string }).text).toBe("hello");
    expect((userMessages[1]?.payload as { text: string }).text).toBe("world");

    db.close();
  });
});

// ---------------------------------------------------------------------------
// CircuitBreaker state transition integration tests
// ---------------------------------------------------------------------------

describe("CircuitBreaker state transitions", () => {
  function makeConfig(overrides?: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
    return {
      name: "integration-test",
      failureThreshold: 3,
      resetTimeoutMs: 100,
      halfOpenMaxAttempts: 1,
      ...overrides,
    };
  }

  test("closed -> open after N failures", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 3 }), logger);
    const fail = (): Promise<never> => Promise.reject(new Error("fail"));

    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(0);

    // Failure 1: still closed
    await cb.execute(fail);
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(1);

    // Failure 2: still closed
    await cb.execute(fail);
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(2);

    // Failure 3: opens
    await cb.execute(fail);
    expect(cb.getStatus().state).toBe("open");
    expect(cb.getStatus().failures).toBe(3);

    // While open, calls are rejected immediately
    const blocked = await cb.execute(async () => "should not run");
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe("CIRCUIT_OPEN");
    }
  });

  test("open -> half-open after timeout, then closed on success", async () => {
    const resetMs = 60;
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: resetMs }), logger);

    // Trip the breaker
    await cb.execute(() => Promise.reject(new Error("trip")));
    expect(cb.getStatus().state).toBe("open");

    // Wait for reset timeout to elapse
    await new Promise((resolve) => setTimeout(resolve, resetMs + 20));

    // Next call should transition through half_open to closed on success
    const result = await cb.execute(async () => "recovered");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("recovered");

    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(0);
  });

  test("half-open -> open on probe failure", async () => {
    const resetMs = 60;
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: resetMs }), logger);

    // Trip the breaker
    await cb.execute(() => Promise.reject(new Error("trip")));
    expect(cb.getStatus().state).toBe("open");

    // Wait for reset timeout
    await new Promise((resolve) => setTimeout(resolve, resetMs + 20));

    // Probe fails -> back to open
    await cb.execute(() => Promise.reject(new Error("probe-fail")));
    expect(cb.getStatus().state).toBe("open");
  });

  test("full cycle: closed -> open -> half-open -> closed", async () => {
    const resetMs = 60;
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 2, resetTimeoutMs: resetMs }), logger);

    // 1. Start closed
    expect(cb.getStatus().state).toBe("closed");

    // 2. Two failures -> open
    await cb.execute(() => Promise.reject(new Error("f1")));
    await cb.execute(() => Promise.reject(new Error("f2")));
    expect(cb.getStatus().state).toBe("open");

    // 3. Wait for timeout -> half-open on next call
    await new Promise((resolve) => setTimeout(resolve, resetMs + 20));

    // 4. Successful probe -> closed
    const result = await cb.execute(async () => "back online");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("back online");
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(0);
  });
});
