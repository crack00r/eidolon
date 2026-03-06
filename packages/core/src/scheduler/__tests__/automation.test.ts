import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { AutomationEngine, deriveName, extractScheduleAndAction, parseDay, parseTime } from "../automation.ts";
import { TaskScheduler } from "../scheduler.ts";

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
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_tasks_next_run ON scheduled_tasks(next_run_at) WHERE enabled = 1;
  `);
  return db;
}

// ---------------------------------------------------------------------------
// parseTime
// ---------------------------------------------------------------------------

describe("parseTime", () => {
  test("parses named times", () => {
    expect(parseTime("midnight")).toBe("00:00");
    expect(parseTime("noon")).toBe("12:00");
    expect(parseTime("9am")).toBe("09:00");
    expect(parseTime("12pm")).toBe("12:00");
    expect(parseTime("11pm")).toBe("23:00");
    expect(parseTime("1am")).toBe("01:00");
  });

  test("parses am/pm with colon (e.g. 9:30am)", () => {
    expect(parseTime("9:30am")).toBe("09:30");
    expect(parseTime("10:15pm")).toBe("22:15");
    expect(parseTime("12:00am")).toBe("00:00");
    expect(parseTime("12:00pm")).toBe("12:00");
    expect(parseTime("2:00am")).toBe("02:00");
  });

  test("parses simple am/pm (e.g. 9am)", () => {
    expect(parseTime("9am")).toBe("09:00");
    expect(parseTime("11pm")).toBe("23:00");
    expect(parseTime("12am")).toBe("00:00");
    expect(parseTime("12pm")).toBe("12:00");
  });

  test("parses 24-hour format (e.g. 14:30)", () => {
    expect(parseTime("14:30")).toBe("14:30");
    expect(parseTime("09:00")).toBe("09:00");
    expect(parseTime("0:00")).toBe("00:00");
    expect(parseTime("23:59")).toBe("23:59");
  });

  test("returns null for invalid input", () => {
    expect(parseTime("invalid")).toBeNull();
    expect(parseTime("25:00")).toBeNull();
    expect(parseTime("")).toBeNull();
    expect(parseTime("abc:def")).toBeNull();
  });

  test("trims and lowercases input", () => {
    expect(parseTime("  9AM  ")).toBe("09:00");
    expect(parseTime("  NOON  ")).toBe("12:00");
  });
});

// ---------------------------------------------------------------------------
// parseDay
// ---------------------------------------------------------------------------

describe("parseDay", () => {
  test("parses full day names", () => {
    expect(parseDay("sunday")).toBe(0);
    expect(parseDay("monday")).toBe(1);
    expect(parseDay("tuesday")).toBe(2);
    expect(parseDay("wednesday")).toBe(3);
    expect(parseDay("thursday")).toBe(4);
    expect(parseDay("friday")).toBe(5);
    expect(parseDay("saturday")).toBe(6);
  });

  test("parses abbreviated day names", () => {
    expect(parseDay("sun")).toBe(0);
    expect(parseDay("mon")).toBe(1);
    expect(parseDay("tue")).toBe(2);
    expect(parseDay("wed")).toBe(3);
    expect(parseDay("thu")).toBe(4);
    expect(parseDay("fri")).toBe(5);
    expect(parseDay("sat")).toBe(6);
  });

  test("handles plural day names", () => {
    expect(parseDay("mondays")).toBe(1);
    expect(parseDay("tuesdays")).toBe(2);
    expect(parseDay("sundays")).toBe(0);
  });

  test("is case-insensitive", () => {
    expect(parseDay("MONDAY")).toBe(1);
    expect(parseDay("Friday")).toBe(5);
  });

  test("returns null for invalid input", () => {
    expect(parseDay("invalid")).toBeNull();
    expect(parseDay("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractScheduleAndAction
// ---------------------------------------------------------------------------

describe("extractScheduleAndAction", () => {
  test("parses 'every <day> at <time>' pattern", () => {
    const result = extractScheduleAndAction("every Monday at 9am research TypeScript news");
    expect(result).not.toBeNull();
    expect(result!.cron).toBe("09:00:1");
    expect(result!.actionText).toBe("research TypeScript news");
  });

  test("parses 'every day at <time>' pattern", () => {
    const result = extractScheduleAndAction("every day at 8am check my emails");
    expect(result).not.toBeNull();
    expect(result!.cron).toBe("08:00");
    expect(result!.actionText).toBe("check my emails");
  });

  test("parses 'daily at <time>' pattern", () => {
    const result = extractScheduleAndAction("daily at 14:30 generate a summary");
    expect(result).not.toBeNull();
    expect(result!.cron).toBe("14:30");
    expect(result!.actionText).toBe("generate a summary");
  });

  test("parses 'every N minutes' pattern", () => {
    const result = extractScheduleAndAction("every 15 minutes check the server status");
    expect(result).not.toBeNull();
    expect(result!.cron).toBe("*/15");
    expect(result!.actionText).toBe("check the server status");
  });

  test("parses 'every N hours' pattern", () => {
    const result = extractScheduleAndAction("every 2 hours check for updates");
    expect(result).not.toBeNull();
    // 2 hours = 120 minutes
    expect(result!.cron).toBe("*/120");
    expect(result!.actionText).toBe("check for updates");
  });

  test("parses 'every morning' pattern", () => {
    const result = extractScheduleAndAction("every morning give me the weather report");
    expect(result).not.toBeNull();
    expect(result!.cron).toBe("08:00");
    expect(result!.actionText).toBe("give me the weather report");
  });

  test("parses 'every evening' pattern", () => {
    const result = extractScheduleAndAction("every evening send me a daily digest");
    expect(result).not.toBeNull();
    expect(result!.cron).toBe("18:00");
    expect(result!.actionText).toBe("send me a daily digest");
  });

  test("parses 'weekdays at <time>' pattern", () => {
    const result = extractScheduleAndAction("weekdays at 9am check my calendar");
    expect(result).not.toBeNull();
    expect(result!.cron).toBe("09:00:1");
    expect(result!.actionText).toBe("check my calendar");
  });

  test("strips leading conjunctions from action text", () => {
    const result1 = extractScheduleAndAction("every day at 9am then do something");
    expect(result1).not.toBeNull();
    expect(result1!.actionText).toBe("do something");

    const result2 = extractScheduleAndAction("every day at 9am and then check things");
    expect(result2).not.toBeNull();
    expect(result2!.actionText).toBe("check things");
  });

  test("uses full input as action when no action text remains", () => {
    const result = extractScheduleAndAction("every morning");
    expect(result).not.toBeNull();
    expect(result!.actionText).toBe("every morning");
  });

  test("returns null for unparseable input", () => {
    expect(extractScheduleAndAction("do something random")).toBeNull();
    expect(extractScheduleAndAction("")).toBeNull();
    expect(extractScheduleAndAction("just a sentence")).toBeNull();
  });

  test("handles plural day names", () => {
    const result = extractScheduleAndAction("every Fridays at 5pm celebrate the weekend");
    expect(result).not.toBeNull();
    expect(result!.cron).toBe("17:00:5");
  });
});

// ---------------------------------------------------------------------------
// deriveName
// ---------------------------------------------------------------------------

describe("deriveName", () => {
  test("capitalizes first letter", () => {
    expect(deriveName("check server status")).toBe("Check server status");
  });

  test("truncates long names to 60 characters with ellipsis", () => {
    const longText = "a".repeat(80);
    const result = deriveName(longText);
    expect(result.length).toBe(60);
    expect(result.endsWith("...")).toBe(true);
  });

  test("normalizes whitespace", () => {
    expect(deriveName("  multiple   spaces   here  ")).toBe("Multiple spaces here");
  });

  test("handles short text without truncation", () => {
    expect(deriveName("short")).toBe("Short");
  });
});

// ---------------------------------------------------------------------------
// AutomationEngine
// ---------------------------------------------------------------------------

describe("AutomationEngine", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function makeEngine(): AutomationEngine {
    const db = createTestDb();
    databases.push(db);
    const scheduler = new TaskScheduler(db, logger);
    return new AutomationEngine(scheduler, db, logger);
  }

  test("parseNaturalLanguage returns parsed automation for valid input", () => {
    const engine = makeEngine();
    const result = engine.parseNaturalLanguage("every Monday at 9am research TypeScript news");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cron).toBe("09:00:1");
      expect(result.value.prompt).toBe("research TypeScript news");
      expect(result.value.deliverTo).toBe("telegram");
      expect(result.value.name).toBe("Research TypeScript news");
    }
  });

  test("parseNaturalLanguage uses provided default channel", () => {
    const engine = makeEngine();
    const result = engine.parseNaturalLanguage("daily at 8am check things", "discord");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.deliverTo).toBe("discord");
    }
  });

  test("parseNaturalLanguage returns error for unparseable input", () => {
    const engine = makeEngine();
    const result = engine.parseNaturalLanguage("just do something random");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_INVALID");
    }
  });

  test("create persists automation as scheduled task", () => {
    const engine = makeEngine();
    const result = engine.create("every day at 8am check my emails");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBeDefined();
      expect(result.value.cron).toBe("08:00");
      expect(result.value.prompt).toBe("check my emails");
      expect(result.value.deliverTo).toBe("telegram");
      expect(result.value.originalInput).toBe("every day at 8am check my emails");
      expect(result.value.enabled).toBe(true);
      expect(result.value.createdAt).toBeDefined();
    }
  });

  test("create returns error for unparseable input", () => {
    const engine = makeEngine();
    const result = engine.create("random gibberish");

    expect(result.ok).toBe(false);
  });

  test("list returns only automation tasks", () => {
    const engine = makeEngine();

    // Create automation
    engine.create("daily at 9am do stuff");

    // Create non-automation task via scheduler directly
    const db = databases[0]!;
    const scheduler = new TaskScheduler(db, logger);
    scheduler.create({
      name: "non-automation",
      type: "recurring",
      cron: "*/30",
      action: "some-other-action",
      payload: {},
    });

    const result = engine.list();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.prompt).toBe("do stuff");
    }
  });

  test("list with enabledOnly=true filters disabled automations", () => {
    const engine = makeEngine();

    const createResult = engine.create("daily at 9am, do stuff");
    engine.create("daily at 10am do more stuff");

    if (createResult.ok) {
      const db = databases[0]!;
      const scheduler = new TaskScheduler(db, logger);
      scheduler.setEnabled(createResult.value.id, false);
    }

    const result = engine.list(true);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]!.prompt).toBe("do more stuff");
    }
  });

  test("delete removes automation by ID", () => {
    const engine = makeEngine();
    const createResult = engine.create("daily at 9am check things");

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const deleteResult = engine.delete(createResult.value.id);
    expect(deleteResult.ok).toBe(true);

    const getResult = engine.get(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBeNull();
    }
  });

  test("delete returns error for non-existent ID", () => {
    const engine = makeEngine();
    const result = engine.delete("non-existent-id");
    expect(result.ok).toBe(false);
  });

  test("delete returns error for non-automation task", () => {
    const engine = makeEngine();
    const db = databases[0]!;
    const scheduler = new TaskScheduler(db, logger);

    const createResult = scheduler.create({
      name: "not-an-automation",
      type: "recurring",
      cron: "*/30",
      action: "ping",
      payload: {},
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const deleteResult = engine.delete(createResult.value.id);
    expect(deleteResult.ok).toBe(false);
    if (!deleteResult.ok) {
      expect(deleteResult.error.message).toContain("is not an automation");
    }
  });

  test("get returns automation by ID", () => {
    const engine = makeEngine();
    const createResult = engine.create("every Monday at 9am research news");

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const getResult = engine.get(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).not.toBeNull();
      expect(getResult.value!.prompt).toBe("research news");
      expect(getResult.value!.cron).toBe("09:00:1");
    }
  });

  test("get returns null for non-existent ID", () => {
    const engine = makeEngine();
    const result = engine.get("non-existent");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  test("get returns null for non-automation task", () => {
    const engine = makeEngine();
    const db = databases[0]!;
    const scheduler = new TaskScheduler(db, logger);

    const createResult = scheduler.create({
      name: "not-automation",
      type: "once",
      runAt: Date.now() + 60_000,
      action: "ping",
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const getResult = engine.get(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBeNull();
    }
  });
});
