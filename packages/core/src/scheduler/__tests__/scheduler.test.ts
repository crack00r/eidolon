import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { TaskScheduler, validateCronExpression } from "../scheduler.ts";

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
  db.exec(`
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('once','recurring','conditional')),
      cron TEXT,
      run_at INTEGER,
      condition TEXT,
      action TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at INTEGER,
      next_run_at INTEGER,
      created_at INTEGER NOT NULL,
      timezone TEXT
    );
    CREATE INDEX idx_tasks_next_run ON scheduled_tasks(next_run_at) WHERE enabled = 1;
  `);
  return db;
}

describe("TaskScheduler", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function makeScheduler(): TaskScheduler {
    const db = createTestDb();
    databases.push(db);
    return new TaskScheduler(db, logger);
  }

  test("create stores task and computes nextRunAt for recurring", () => {
    const scheduler = makeScheduler();

    const result = scheduler.create({
      name: "nightly-dream",
      type: "recurring",
      cron: "02:00",
      action: "dream",
      payload: { depth: "deep" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("nightly-dream");
      expect(result.value.type).toBe("recurring");
      expect(result.value.cron).toBe("02:00");
      expect(result.value.action).toBe("dream");
      expect(result.value.payload).toEqual({ depth: "deep" });
      expect(result.value.enabled).toBe(true);
      expect(result.value.nextRunAt).toBeDefined();
      expect(result.value.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    }
  });

  test("create stores one-off task with runAt as nextRunAt", () => {
    const scheduler = makeScheduler();
    const futureTime = Date.now() + 3_600_000;

    const result = scheduler.create({
      name: "one-time-task",
      type: "once",
      runAt: futureTime,
      action: "notify",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.type).toBe("once");
      expect(result.value.nextRunAt).toBe(futureTime);
    }
  });

  test("getNextDue returns due task", () => {
    const scheduler = makeScheduler();
    const pastTime = Date.now() - 60_000;

    scheduler.create({
      name: "overdue-task",
      type: "once",
      runAt: pastTime,
      action: "cleanup",
    });

    const result = scheduler.getNextDue();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).not.toBeNull();
      expect(result.value?.name).toBe("overdue-task");
    }
  });

  test("getNextDue returns null when nothing due", () => {
    const scheduler = makeScheduler();
    const futureTime = Date.now() + 3_600_000;

    scheduler.create({
      name: "future-task",
      type: "once",
      runAt: futureTime,
      action: "notify",
    });

    const result = scheduler.getNextDue();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  test("markExecuted updates lastRunAt and nextRunAt for recurring", () => {
    const scheduler = makeScheduler();

    const createResult = scheduler.create({
      name: "every-30",
      type: "recurring",
      cron: "*/30",
      action: "check",
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const taskId = createResult.value.id;
    const execResult = scheduler.markExecuted(taskId);
    expect(execResult.ok).toBe(true);

    const getResult = scheduler.get(taskId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok && getResult.value) {
      expect(getResult.value.lastRunAt).toBeDefined();
      expect(getResult.value.nextRunAt).toBeDefined();
      // nextRunAt should be ~30 minutes from now
      const expectedMin = Date.now() + 29 * 60_000;
      const expectedMax = Date.now() + 31 * 60_000;
      expect(getResult.value.nextRunAt).toBeGreaterThan(expectedMin);
      expect(getResult.value.nextRunAt).toBeLessThan(expectedMax);
    }
  });

  test("markExecuted disables one-off tasks", () => {
    const scheduler = makeScheduler();
    const pastTime = Date.now() - 60_000;

    const createResult = scheduler.create({
      name: "once-task",
      type: "once",
      runAt: pastTime,
      action: "run",
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const taskId = createResult.value.id;
    scheduler.markExecuted(taskId);

    const getResult = scheduler.get(taskId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok && getResult.value) {
      expect(getResult.value.enabled).toBe(false);
      expect(getResult.value.lastRunAt).toBeDefined();
      expect(getResult.value.nextRunAt).toBeUndefined();
    }
  });

  test("setEnabled toggles task", () => {
    const scheduler = makeScheduler();

    const createResult = scheduler.create({
      name: "toggle-task",
      type: "recurring",
      cron: "*/30",
      action: "ping",
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const taskId = createResult.value.id;

    // Disable
    const disableResult = scheduler.setEnabled(taskId, false);
    expect(disableResult.ok).toBe(true);

    const getDisabled = scheduler.get(taskId);
    expect(getDisabled.ok).toBe(true);
    if (getDisabled.ok && getDisabled.value) {
      expect(getDisabled.value.enabled).toBe(false);
    }

    // Re-enable
    const enableResult = scheduler.setEnabled(taskId, true);
    expect(enableResult.ok).toBe(true);

    const getEnabled = scheduler.get(taskId);
    expect(getEnabled.ok).toBe(true);
    if (getEnabled.ok && getEnabled.value) {
      expect(getEnabled.value.enabled).toBe(true);
    }
  });

  test("delete removes task", () => {
    const scheduler = makeScheduler();

    const createResult = scheduler.create({
      name: "to-delete",
      type: "once",
      runAt: Date.now() + 60_000,
      action: "noop",
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const taskId = createResult.value.id;
    const deleteResult = scheduler.delete(taskId);
    expect(deleteResult.ok).toBe(true);

    const getResult = scheduler.get(taskId);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBeNull();
    }
  });

  test("getDueTasks returns all due tasks", () => {
    const scheduler = makeScheduler();
    const pastTime = Date.now() - 60_000;

    scheduler.create({ name: "due-1", type: "once", runAt: pastTime, action: "a" });
    scheduler.create({ name: "due-2", type: "once", runAt: pastTime - 1000, action: "b" });
    scheduler.create({ name: "not-due", type: "once", runAt: Date.now() + 3_600_000, action: "c" });

    const result = scheduler.getDueTasks();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      const names = result.value.map((t) => t.name);
      expect(names).toContain("due-1");
      expect(names).toContain("due-2");
    }
  });

  test("list returns all tasks", () => {
    const scheduler = makeScheduler();

    scheduler.create({ name: "task-1", type: "once", runAt: Date.now(), action: "a" });
    scheduler.create({ name: "task-2", type: "recurring", cron: "*/10", action: "b" });

    const result = scheduler.list();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  test("list with enabledOnly filters disabled tasks", () => {
    const scheduler = makeScheduler();

    const createResult = scheduler.create({ name: "task-1", type: "once", runAt: Date.now(), action: "a" });
    scheduler.create({ name: "task-2", type: "recurring", cron: "*/10", action: "b" });

    if (createResult.ok) {
      scheduler.setEnabled(createResult.value.id, false);
    }

    const result = scheduler.list(true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.name).toBe("task-2");
    }
  });
});

describe("TaskScheduler.computeNextRun", () => {
  test("handles HH:MM format", () => {
    // Use a known reference time: 2025-01-15T10:00:00.000Z
    const reference = new Date("2025-01-15T10:00:00.000Z").getTime();

    // "14:00" should be later today (if reference is 10:00 UTC)
    const next = TaskScheduler.computeNextRun("14:00", reference);
    const nextDate = new Date(next);
    expect(nextDate.getHours()).toBe(14);
    expect(nextDate.getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(reference);
  });

  test("HH:MM rolls over to next day if time has passed", () => {
    // Reference: 2025-01-15T15:00:00.000Z
    const reference = new Date("2025-01-15T15:00:00.000Z").getTime();

    // "14:00" is in the past for today, should roll to tomorrow
    const next = TaskScheduler.computeNextRun("14:00", reference);
    const nextDate = new Date(next);
    expect(nextDate.getHours()).toBe(14);
    expect(nextDate.getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(reference);
    // Should be tomorrow
    expect(nextDate.getDate()).toBe(new Date(reference).getDate() + 1);
  });

  test("handles */N format", () => {
    const reference = Date.now();
    const next = TaskScheduler.computeNextRun("*/30", reference);

    // Should be 30 minutes from reference
    expect(next).toBe(reference + 30 * 60_000);
  });

  test("handles HH:MM:dow format", () => {
    // 2025-01-15 is a Wednesday (dow=3)
    const reference = new Date("2025-01-15T10:00:00.000Z").getTime();

    // "09:00:1" = Monday 9am. Next Monday from Wed is 5 days ahead.
    const next = TaskScheduler.computeNextRun("09:00:1", reference);
    const nextDate = new Date(next);
    expect(nextDate.getDay()).toBe(1); // Monday
    expect(nextDate.getHours()).toBe(9);
    expect(next).toBeGreaterThan(reference);
  });

  test("falls back to 1 hour for unknown format", () => {
    const reference = Date.now();
    const next = TaskScheduler.computeNextRun("invalid", reference);
    expect(next).toBe(reference + 3_600_000);
  });

  test("computes next run with timezone", () => {
    // Use a known reference time: 2025-01-15T10:00:00.000Z (UTC)
    // In Europe/Berlin this is 11:00 CET
    const reference = new Date("2025-01-15T10:00:00.000Z").getTime();

    // "14:00" in Europe/Berlin = 13:00 UTC
    const next = TaskScheduler.computeNextRun("14:00", reference, "Europe/Berlin");
    const nextDate = new Date(next);

    // Verify the time in Berlin timezone is 14:00
    const berlinTime = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Berlin",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(nextDate);

    const hour = berlinTime.find((p) => p.type === "hour")?.value;
    const minute = berlinTime.find((p) => p.type === "minute")?.value;
    expect(hour).toBe("14");
    expect(minute).toBe("00");
    expect(next).toBeGreaterThan(reference);
  });
});

describe("validateCronExpression", () => {
  test("accepts valid HH:MM", () => {
    expect(validateCronExpression("00:00")).toBeNull();
    expect(validateCronExpression("23:59")).toBeNull();
    expect(validateCronExpression("12:30")).toBeNull();
  });

  test("rejects invalid hours in HH:MM", () => {
    const result = validateCronExpression("24:00");
    expect(result).not.toBeNull();
    expect(result).toContain("hour");
  });

  test("rejects invalid minutes in HH:MM", () => {
    const result = validateCronExpression("12:60");
    expect(result).not.toBeNull();
    expect(result).toContain("minute");
  });

  test("accepts valid */N", () => {
    expect(validateCronExpression("*/1")).toBeNull();
    expect(validateCronExpression("*/30")).toBeNull();
    expect(validateCronExpression("*/59")).toBeNull();
  });

  test("rejects invalid */N interval", () => {
    const result = validateCronExpression("*/0");
    expect(result).not.toBeNull();
    expect(result).toContain("interval");

    // */60 is now valid (range extended to 1440 for hourly intervals)
    const result2 = validateCronExpression("*/1441");
    expect(result2).not.toBeNull();
    expect(result2).toContain("interval");
  });

  test("accepts valid HH:MM:dow", () => {
    expect(validateCronExpression("09:00:0")).toBeNull();
    expect(validateCronExpression("09:00:7")).toBeNull();
    expect(validateCronExpression("23:59:6")).toBeNull();
  });

  test("rejects invalid day of week", () => {
    const result = validateCronExpression("09:00:8");
    expect(result).not.toBeNull();
    expect(result).toContain("day of week");
  });

  test("rejects invalid hours in HH:MM:dow", () => {
    const result = validateCronExpression("25:00:1");
    expect(result).not.toBeNull();
    expect(result).toContain("hour");
  });

  test("rejects unrecognized format", () => {
    const result = validateCronExpression("foobar");
    expect(result).not.toBeNull();
    expect(result).toContain("Unrecognized");
  });
});

describe("TaskScheduler cron validation on create", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function makeScheduler(): TaskScheduler {
    const db = createTestDb();
    databases.push(db);
    return new TaskScheduler(db, logger);
  }

  test("rejects task with invalid cron expression", () => {
    const scheduler = makeScheduler();

    const result = scheduler.create({
      name: "bad-cron",
      type: "recurring",
      cron: "25:00",
      action: "test",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("hour");
    }
  });

  test("rejects task with invalid timezone", () => {
    const scheduler = makeScheduler();

    const result = scheduler.create({
      name: "bad-tz",
      type: "recurring",
      cron: "14:00",
      action: "test",
      timezone: "Invalid/Timezone",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timezone");
    }
  });

  test("accepts task with valid timezone", () => {
    const scheduler = makeScheduler();

    const result = scheduler.create({
      name: "berlin-task",
      type: "recurring",
      cron: "14:00",
      action: "test",
      timezone: "Europe/Berlin",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timezone).toBe("Europe/Berlin");
    }
  });
});
