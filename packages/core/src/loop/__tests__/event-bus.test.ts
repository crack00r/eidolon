import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.js";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.js";
import type { Logger } from "../../logging/logger.js";
import { EventBus } from "../event-bus.js";

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

describe("EventBus", () => {
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

  test("publish persists event to database", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);

    const result = bus.publish(
      "user:message",
      { text: "hello" },
      {
        priority: "high",
        source: "test",
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = db.query("SELECT * FROM events WHERE id = ?").get(result.value.id) as {
      id: string;
      type: string;
      priority: string;
      payload: string;
      source: string;
    };

    expect(row).not.toBeNull();
    expect(row.type).toBe("user:message");
    expect(row.priority).toBe("high");
    expect(row.source).toBe("test");
    expect(JSON.parse(row.payload)).toEqual({ text: "hello" });
  });

  test("publish notifies subscribers", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const received: unknown[] = [];

    bus.subscribe("user:message", (event) => {
      received.push(event.payload);
    });

    bus.publish("user:message", { text: "hello" });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ text: "hello" });
  });

  test("dequeue returns highest priority event", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);

    bus.publish("system:health_check", { status: "ok" }, { priority: "low" });
    bus.publish("user:message", { text: "urgent" }, { priority: "critical" });
    bus.publish("scheduler:task_due", { taskId: "t1" }, { priority: "normal" });

    const result = bus.dequeue();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).not.toBeNull();
    if (!result.value) return;
    expect(result.value.priority).toBe("critical");
    expect(result.value.type).toBe("user:message");
  });

  test("dequeue returns null when empty", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);

    const result = bus.dequeue();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  test("markProcessed sets processed_at", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);

    const pubResult = bus.publish("user:message", { text: "test" });
    expect(pubResult.ok).toBe(true);
    if (!pubResult.ok) return;

    const markResult = bus.markProcessed(pubResult.value.id);
    expect(markResult.ok).toBe(true);

    const row = db.query("SELECT processed_at FROM events WHERE id = ?").get(pubResult.value.id) as {
      processed_at: number | null;
    };
    expect(row.processed_at).not.toBeNull();
    expect(typeof row.processed_at).toBe("number");

    // Should not appear in dequeue anymore
    const dequeueResult = bus.dequeue();
    expect(dequeueResult.ok).toBe(true);
    if (dequeueResult.ok) {
      expect(dequeueResult.value).toBeNull();
    }
  });

  test("defer increments retry count", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);

    const pubResult = bus.publish("user:message", { text: "retry me" });
    expect(pubResult.ok).toBe(true);
    if (!pubResult.ok) return;

    bus.defer(pubResult.value.id);
    bus.defer(pubResult.value.id);

    const row = db.query("SELECT retry_count FROM events WHERE id = ?").get(pubResult.value.id) as {
      retry_count: number;
    };
    expect(row.retry_count).toBe(2);

    // Event should still be unprocessed (available for dequeue)
    const dequeueResult = bus.dequeue();
    expect(dequeueResult.ok).toBe(true);
    if (dequeueResult.ok && dequeueResult.value) {
      expect(dequeueResult.value.id).toBe(pubResult.value.id);
    }
  });

  test("pendingCount returns unprocessed count", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);

    bus.publish("user:message", { text: "one" });
    bus.publish("user:message", { text: "two" });
    bus.publish("user:message", { text: "three" });

    const countResult = bus.pendingCount();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(3);

    // Mark one processed
    const deqResult = bus.dequeue();
    if (deqResult.ok && deqResult.value) {
      bus.markProcessed(deqResult.value.id);
    }

    const countResult2 = bus.pendingCount();
    expect(countResult2.ok).toBe(true);
    if (countResult2.ok) {
      expect(countResult2.value).toBe(2);
    }
  });

  test("drain returns all unprocessed events", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);

    bus.publish("user:message", { text: "one" }, { priority: "normal" });
    bus.publish("system:shutdown", {}, { priority: "critical" });
    bus.publish("system:health_check", {}, { priority: "low" });

    const result = bus.drain();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(3);
    // Should be ordered by priority
    const [first, second, third] = result.value;
    expect(first?.priority).toBe("critical");
    expect(second?.priority).toBe("normal");
    expect(third?.priority).toBe("low");
  });
});
