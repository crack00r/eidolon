import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { RateLimitTracker } from "../rate-limits.ts";

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
    CREATE TABLE account_usage (
      account_name TEXT NOT NULL,
      hour_bucket INTEGER NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      requests INTEGER NOT NULL DEFAULT 0,
      errors INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      PRIMARY KEY (account_name, hour_bucket)
    );
    CREATE INDEX idx_account_usage_hour ON account_usage(hour_bucket);
  `);
  return db;
}

describe("RateLimitTracker", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function makeTracker(): { tracker: RateLimitTracker; db: Database } {
    const db = createTestDb();
    databases.push(db);
    const tracker = new RateLimitTracker(db, logger);
    return { tracker, db };
  }

  test("records usage and reflects in account status", () => {
    const { tracker } = makeTracker();
    tracker.setMaxTokensPerHour("primary", 100_000);

    tracker.recordUsage("primary", 5_000);
    tracker.recordUsage("primary", 3_000);

    const status = tracker.getAccountStatus("primary");
    expect(status.accountName).toBe("primary");
    expect(status.tokensUsedCurrentHour).toBe(8_000);
    expect(status.maxTokensPerHour).toBe(100_000);
    expect(status.remainingTokens).toBe(92_000);
    expect(status.isAvailable).toBe(true);
    expect(status.consecutiveErrors).toBe(0);
  });

  test("marks account as unavailable when over budget", () => {
    const { tracker } = makeTracker();
    tracker.setMaxTokensPerHour("acct-limited", 10_000);

    tracker.recordUsage("acct-limited", 10_000);

    const status = tracker.getAccountStatus("acct-limited");
    expect(status.isAvailable).toBe(false);
    expect(status.remainingTokens).toBe(0);
  });

  test("tracks cooldown and marks account as unavailable", () => {
    const { tracker } = makeTracker();
    const futureTime = Date.now() + 60_000;

    tracker.recordCooldown("cooling", futureTime);

    const status = tracker.getAccountStatus("cooling");
    expect(status.isAvailable).toBe(false);
    expect(status.cooldownUntil).toBe(futureTime);
  });

  test("clears cooldown and makes account available again", () => {
    const { tracker } = makeTracker();
    const futureTime = Date.now() + 60_000;

    tracker.recordCooldown("cooling", futureTime);
    expect(tracker.getAccountStatus("cooling").isAvailable).toBe(false);

    tracker.clearCooldown("cooling");
    expect(tracker.getAccountStatus("cooling").isAvailable).toBe(true);
    expect(tracker.getAccountStatus("cooling").cooldownUntil).toBeNull();
  });

  test("records errors and increments consecutive count", () => {
    const { tracker } = makeTracker();

    tracker.recordError("error-acct", "rate_limit");
    tracker.recordError("error-acct", "rate_limit");
    tracker.recordError("error-acct", "timeout");

    const status = tracker.getAccountStatus("error-acct");
    expect(status.consecutiveErrors).toBe(3);
    expect(status.lastErrorAt).not.toBeNull();
    expect(status.lastErrorAt).toBeGreaterThan(0);
  });

  test("recording usage resets consecutive errors", () => {
    const { tracker } = makeTracker();

    tracker.recordError("recovery-acct", "rate_limit");
    tracker.recordError("recovery-acct", "rate_limit");
    expect(tracker.getAccountStatus("recovery-acct").consecutiveErrors).toBe(2);

    tracker.recordUsage("recovery-acct", 500);
    expect(tracker.getAccountStatus("recovery-acct").consecutiveErrors).toBe(0);
  });

  test("getAllAccountStatuses returns statuses for all known accounts", () => {
    const { tracker } = makeTracker();
    tracker.setMaxTokensPerHour("alpha", 50_000);
    tracker.setMaxTokensPerHour("beta", 100_000);

    tracker.recordUsage("alpha", 1_000);
    tracker.recordUsage("beta", 2_000);
    tracker.recordError("gamma", "connection_error");

    const statuses = tracker.getAllAccountStatuses();
    const names = statuses.map((s) => s.accountName).sort();
    expect(names).toContain("alpha");
    expect(names).toContain("beta");
    expect(names).toContain("gamma");
    expect(statuses.length).toBeGreaterThanOrEqual(3);
  });

  test("getHourlyUsage returns historical data", () => {
    const { tracker, db } = makeTracker();
    const now = Date.now();
    const currentHour = Math.floor(now / 3_600_000) * 3_600_000;
    const prevHour = currentHour - 3_600_000;

    // Insert backdated data directly for testing
    db.query(
      `INSERT INTO account_usage (account_name, hour_bucket, tokens_used, requests, errors)
       VALUES (?, ?, 5000, 10, 0)`,
    ).run("hist-acct", prevHour);

    tracker.recordUsage("hist-acct", 2_000);

    const hourly = tracker.getHourlyUsage("hist-acct", 24);
    expect(hourly.length).toBeGreaterThanOrEqual(2);

    const prevHourEntry = hourly.find((e) => e.hour === prevHour);
    expect(prevHourEntry).toBeDefined();
    expect(prevHourEntry?.tokens).toBe(5_000);
  });

  test("account with no max tokens reports -1 remaining", () => {
    const { tracker } = makeTracker();
    tracker.recordUsage("no-limit", 99_999);

    const status = tracker.getAccountStatus("no-limit");
    expect(status.maxTokensPerHour).toBe(0);
    expect(status.remainingTokens).toBe(-1);
    expect(status.isAvailable).toBe(true);
  });
});
