import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { TokenUsage } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { calculateCost, TokenTracker } from "../token-tracker.ts";

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
    CREATE TABLE token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      session_type TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL,
      timestamp INTEGER NOT NULL
    );
    CREATE INDEX idx_token_usage_session ON token_usage(session_id);
    CREATE INDEX idx_token_usage_timestamp ON token_usage(timestamp);
  `);
  return db;
}

function makeUsage(overrides?: Partial<TokenUsage>): TokenUsage {
  return {
    sessionId: "sess-1",
    sessionType: "task",
    model: "claude-sonnet-4-20250514",
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.01,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("calculateCost", () => {
  test("calculates cost correctly for Sonnet", () => {
    // 1M input tokens at 300 cents = $3.00
    const cost = calculateCost("claude-sonnet-4-20250514", 1_000_000, 0);
    expect(cost).toBeCloseTo(3.0, 2);
  });

  test("calculates cost correctly for Opus with cache", () => {
    // 1M input at 1500c = $15, 1M output at 7500c = $75, 1M cache read at 150c = $1.50
    const cost = calculateCost("claude-opus-4-20250514", 1_000_000, 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(91.5, 2);
  });

  test("unknown model defaults to Sonnet pricing", () => {
    const known = calculateCost("claude-sonnet-4-20250514", 1000, 1000);
    const unknown = calculateCost("unknown-model-v1", 1000, 1000);
    expect(unknown).toBeCloseTo(known, 6);
  });
});

describe("TokenTracker", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function makeTracker(): TokenTracker {
    const db = createTestDb();
    databases.push(db);
    return new TokenTracker(db, logger);
  }

  test("record usage and retrieve by session", () => {
    const tracker = makeTracker();
    const usage = makeUsage({ sessionId: "sess-42" });

    const result = tracker.record(usage);
    expect(result.ok).toBe(true);

    const records = tracker.getSessionUsage("sess-42");
    expect(records.ok).toBe(true);
    if (records.ok) {
      expect(records.value).toHaveLength(1);
      expect(records.value[0]?.sessionId).toBe("sess-42");
      expect(records.value[0]?.model).toBe("claude-sonnet-4-20250514");
    }
  });

  test("summary aggregates correctly by period", () => {
    const tracker = makeTracker();
    const now = Date.now();

    tracker.record(makeUsage({ sessionId: "s1", costUsd: 1.5, timestamp: now - 1000 }));
    tracker.record(makeUsage({ sessionId: "s2", costUsd: 2.5, sessionType: "learning", timestamp: now - 2000 }));

    const summary = tracker.getSummary("hour");
    expect(summary.ok).toBe(true);
    if (summary.ok) {
      expect(summary.value.totalCostUsd).toBeCloseTo(4.0, 2);
      expect(summary.value.period).toBe("hour");
      expect(summary.value.bySessionType.task).toBeCloseTo(1.5, 2);
      expect(summary.value.bySessionType.learning).toBeCloseTo(2.5, 2);
    }
  });

  test("empty session returns empty array", () => {
    const tracker = makeTracker();
    const result = tracker.getSessionUsage("nonexistent");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });
});
