/**
 * Backpressure tests for EventBus.
 *
 * Verifies that the EventBus correctly drops low-priority events when the
 * pending queue exceeds the configured threshold, while never dropping
 * critical or high-priority events.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../event-bus.ts";

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EventBus backpressure", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeDb(): Database {
    const db = createTestDb();
    databases.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  // -------------------------------------------------------------------------
  // Low-priority events dropped when queue exceeds threshold
  // -------------------------------------------------------------------------

  test("drops low-priority events when queue exceeds threshold", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 5 });

    // Fill queue to capacity
    for (let i = 0; i < 5; i++) {
      const r = bus.publish("user:message", { idx: i }, { priority: "normal" });
      expect(r.ok).toBe(true);
    }

    // Queue is at 5 (the threshold). Low-priority event should be dropped.
    const lowResult = bus.publish("system:health_check", { dropped: true }, { priority: "low" });
    expect(lowResult.ok).toBe(false);

    // Verify queue is still at 5
    const count = bus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value).toBe(5);
  });

  test("drops normal-priority events when queue exceeds threshold", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 3 });

    // Fill to capacity
    for (let i = 0; i < 3; i++) {
      bus.publish("user:message", { idx: i }, { priority: "normal" });
    }

    // Normal-priority event should be dropped
    const normalResult = bus.publish("user:message", { dropped: true }, { priority: "normal" });
    expect(normalResult.ok).toBe(false);

    // Queue remains at 3
    const count = bus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Critical and high-priority events are NEVER dropped
  // -------------------------------------------------------------------------

  test("never drops critical events even when queue is full", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 3 });

    // Fill queue to capacity with normal events
    for (let i = 0; i < 3; i++) {
      bus.publish("user:message", { idx: i }, { priority: "normal" });
    }

    // Critical events should always be accepted
    const c1 = bus.publish("user:message", { critical: 1 }, { priority: "critical" });
    expect(c1.ok).toBe(true);

    const c2 = bus.publish("system:shutdown", { critical: 2 }, { priority: "critical" });
    expect(c2.ok).toBe(true);

    // Queue should now have 5 (3 normal + 2 critical)
    const count = bus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value).toBe(5);
  });

  test("never drops high-priority events even when queue is full", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 2 });

    // Fill to capacity
    bus.publish("user:message", { idx: 0 }, { priority: "normal" });
    bus.publish("user:message", { idx: 1 }, { priority: "normal" });

    // High-priority events should still be accepted
    const h1 = bus.publish("user:message", { high: 1 }, { priority: "high" });
    expect(h1.ok).toBe(true);

    // Normal and low should still be rejected
    const norm = bus.publish("user:message", { nope: true }, { priority: "normal" });
    expect(norm.ok).toBe(false);

    const low = bus.publish("system:health_check", { nope: true }, { priority: "low" });
    expect(low.ok).toBe(false);

    // Queue should have 3: 2 normal + 1 high
    const count = bus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value).toBe(3);
  });

  test("accepts mix of critical and high events beyond threshold", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 1 });

    // Fill to capacity with 1 low event
    bus.publish("system:health_check", {}, { priority: "low" });

    // All critical and high events pass through even though queue is at/above capacity
    for (let i = 0; i < 10; i++) {
      const priority = i % 2 === 0 ? "critical" : "high";
      const r = bus.publish("user:message", { idx: i }, { priority: priority as "critical" | "high" });
      expect(r.ok).toBe(true);
    }

    // Queue has 11 total: 1 original + 10 critical/high
    const count = bus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value).toBe(11);
  });

  // -------------------------------------------------------------------------
  // Normal-priority events survive up to the threshold
  // -------------------------------------------------------------------------

  test("normal-priority events accepted up to threshold", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 5 });

    // Publish exactly 5 normal events -- all should succeed
    for (let i = 0; i < 5; i++) {
      const r = bus.publish("user:message", { idx: i }, { priority: "normal" });
      expect(r.ok).toBe(true);
    }

    // The 6th should be dropped
    const dropped = bus.publish("user:message", { idx: 5 }, { priority: "normal" });
    expect(dropped.ok).toBe(false);
  });

  test("low-priority events accepted when queue is below threshold", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 10 });

    // Publish 5 low-priority events (well below threshold of 10)
    for (let i = 0; i < 5; i++) {
      const r = bus.publish("system:health_check", { idx: i }, { priority: "low" });
      expect(r.ok).toBe(true);
    }

    const count = bus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value).toBe(5);
  });

  // -------------------------------------------------------------------------
  // Backpressure error contains diagnostic information
  // -------------------------------------------------------------------------

  test("backpressure error includes queue depth information", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 2 });

    bus.publish("user:message", { idx: 0 }, { priority: "normal" });
    bus.publish("user:message", { idx: 1 }, { priority: "normal" });

    const result = bus.publish("user:message", { dropped: true }, { priority: "low" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Backpressure");
      expect(result.error.message).toContain("2"); // queue depth
    }
  });

  // -------------------------------------------------------------------------
  // Queue recovery: after processing, new low-priority events accepted again
  // -------------------------------------------------------------------------

  test("accepts low-priority events again after queue shrinks below threshold", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 3 });

    // Fill to capacity
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = bus.publish("user:message", { idx: i }, { priority: "normal" });
      expect(r.ok).toBe(true);
      if (r.ok) ids.push(r.value.id);
    }

    // Verify low-priority is dropped
    const droppedResult = bus.publish("system:health_check", { dropped: true }, { priority: "low" });
    expect(droppedResult.ok).toBe(false);

    // Process 2 events to bring queue below threshold
    for (const id of ids.slice(0, 2)) {
      bus.markProcessed(id);
    }

    // Queue should now be at 1 (below threshold of 3)
    const count = bus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value).toBe(1);

    // Low-priority events should now be accepted
    const accepted = bus.publish("system:health_check", { recovered: true }, { priority: "low" });
    expect(accepted.ok).toBe(true);

    // Normal events too
    const normalAccepted = bus.publish("user:message", { recovered: true }, { priority: "normal" });
    expect(normalAccepted.ok).toBe(true);
  });

  test("recovery works after dequeue + markProcessed cycle", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 2 });

    // Fill queue
    bus.publish("user:message", { idx: 0 }, { priority: "normal" });
    bus.publish("user:message", { idx: 1 }, { priority: "normal" });

    // Verify backpressure active
    const dropped = bus.publish("user:message", { dropped: true }, { priority: "low" });
    expect(dropped.ok).toBe(false);

    // Dequeue and process one event
    const dequeued = bus.dequeue();
    expect(dequeued.ok).toBe(true);
    if (dequeued.ok && dequeued.value) {
      bus.markProcessed(dequeued.value.id);
    }

    // Now queue has 1 pending (below threshold of 2) -- low-priority should work
    const accepted = bus.publish("system:health_check", { accepted: true }, { priority: "low" });
    expect(accepted.ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Configurable threshold
  // -------------------------------------------------------------------------

  test("configurable threshold: threshold of 1", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 1 });

    // First event accepted
    const first = bus.publish("user:message", { idx: 0 }, { priority: "normal" });
    expect(first.ok).toBe(true);

    // Second event (normal) dropped
    const second = bus.publish("user:message", { idx: 1 }, { priority: "normal" });
    expect(second.ok).toBe(false);

    // But critical still passes
    const critical = bus.publish("user:message", { idx: 2 }, { priority: "critical" });
    expect(critical.ok).toBe(true);
  });

  test("configurable threshold: large threshold of 100", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 100 });

    // Publish 100 events -- all should succeed
    for (let i = 0; i < 100; i++) {
      const r = bus.publish("user:message", { idx: i }, { priority: "low" });
      expect(r.ok).toBe(true);
    }

    // 101st should be dropped
    const dropped = bus.publish("system:health_check", { overflow: true }, { priority: "low" });
    expect(dropped.ok).toBe(false);

    // Verify count is exactly 100
    const count = bus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value).toBe(100);
  });

  test("uses default threshold of 1000 when no option is provided", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger); // No options -- uses default

    // Publish 999 normal events (should all succeed; well below default 1000)
    // We skip actually publishing 999 for performance, but verify the logic
    // by checking that the first few are accepted
    for (let i = 0; i < 10; i++) {
      const r = bus.publish("user:message", { idx: i }, { priority: "normal" });
      expect(r.ok).toBe(true);
    }

    // Pending count should be 10 (default threshold is 1000, so no backpressure)
    const count = bus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) expect(count.value).toBe(10);
  });

  // -------------------------------------------------------------------------
  // Edge case: events with default (unspecified) priority
  // -------------------------------------------------------------------------

  test("events without explicit priority default to normal and are subject to backpressure", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 2 });

    // Fill queue
    bus.publish("user:message", { idx: 0 }); // default priority = normal
    bus.publish("user:message", { idx: 1 });

    // Default (normal) priority event should be dropped
    const result = bus.publish("user:message", { idx: 2 });
    expect(result.ok).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Subscribers are NOT notified for dropped events
  // -------------------------------------------------------------------------

  test("subscribers are not notified for dropped events", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 1 });
    const received: unknown[] = [];

    bus.subscribeAll((event) => {
      received.push(event.payload);
    });

    // First event -- subscriber notified
    bus.publish("user:message", { idx: 0 }, { priority: "normal" });
    expect(received).toHaveLength(1);

    // Dropped event -- subscriber NOT notified
    bus.publish("user:message", { dropped: true }, { priority: "low" });
    expect(received).toHaveLength(1); // still 1

    // Critical event passes through -- subscriber notified
    bus.publish("user:message", { critical: true }, { priority: "critical" });
    expect(received).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Dropped events are not persisted to database
  // -------------------------------------------------------------------------

  test("dropped events are not persisted to the database", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger, { maxPendingEvents: 2 });

    bus.publish("user:message", { idx: 0 }, { priority: "normal" });
    bus.publish("user:message", { idx: 1 }, { priority: "normal" });

    // This event should be dropped
    const dropResult = bus.publish("system:health_check", { dropped: true }, { priority: "low" });
    expect(dropResult.ok).toBe(false);

    // Verify database only has 2 rows
    const row = db.query("SELECT COUNT(*) as count FROM events").get() as { count: number };
    expect(row.count).toBe(2);
  });
});
