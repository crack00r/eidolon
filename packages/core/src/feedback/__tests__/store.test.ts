import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { CONFIDENCE_ADJUSTMENT, FeedbackStore } from "../store.ts";

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
    CREATE TABLE feedback (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      channel TEXT NOT NULL,
      comment TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_feedback_session ON feedback(session_id);
    CREATE INDEX idx_feedback_created ON feedback(created_at);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FeedbackStore", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeStore(): FeedbackStore {
    const db = createTestDb();
    databases.push(db);
    return new FeedbackStore(db, logger);
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  // -------------------------------------------------------------------------
  // submit()
  // -------------------------------------------------------------------------

  describe("submit", () => {
    test("stores feedback with all fields", () => {
      const store = makeStore();
      const result = store.submit({
        sessionId: "sess-1",
        messageId: "msg-42",
        rating: 5,
        channel: "telegram",
        comment: "Great response!",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.sessionId).toBe("sess-1");
      expect(result.value.messageId).toBe("msg-42");
      expect(result.value.rating).toBe(5);
      expect(result.value.channel).toBe("telegram");
      expect(result.value.comment).toBe("Great response!");
      expect(result.value.id).toBeTruthy();
      expect(result.value.createdAt).toBeGreaterThan(0);
    });

    test("stores feedback without optional fields", () => {
      const store = makeStore();
      const result = store.submit({
        sessionId: "sess-2",
        rating: 3,
        channel: "desktop",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.messageId).toBeUndefined();
      expect(result.value.comment).toBeUndefined();
    });

    test("rejects rating below 1", () => {
      const store = makeStore();
      const result = store.submit({
        sessionId: "sess-1",
        rating: 0,
        channel: "telegram",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("between 1 and 5");
    });

    test("rejects rating above 5", () => {
      const store = makeStore();
      const result = store.submit({
        sessionId: "sess-1",
        rating: 6,
        channel: "telegram",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("between 1 and 5");
    });

    test("rejects non-integer rating", () => {
      const store = makeStore();
      const result = store.submit({
        sessionId: "sess-1",
        rating: 3.5,
        channel: "telegram",
      });

      expect(result.ok).toBe(false);
    });

    test("rejects empty sessionId", () => {
      const store = makeStore();
      const result = store.submit({
        sessionId: "",
        rating: 4,
        channel: "telegram",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("sessionId");
    });

    test("rejects empty channel", () => {
      const store = makeStore();
      const result = store.submit({
        sessionId: "sess-1",
        rating: 4,
        channel: "",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("channel");
    });

    test("truncates overly long comments", () => {
      const store = makeStore();
      const longComment = "x".repeat(3000);
      const result = store.submit({
        sessionId: "sess-1",
        rating: 4,
        channel: "telegram",
        comment: longComment,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.comment).toBeTruthy();
      expect(result.value.comment!.length).toBe(2000);
    });
  });

  // -------------------------------------------------------------------------
  // get()
  // -------------------------------------------------------------------------

  describe("get", () => {
    test("retrieves existing feedback by id", () => {
      const store = makeStore();
      const submitResult = store.submit({
        sessionId: "sess-1",
        rating: 4,
        channel: "desktop",
      });
      expect(submitResult.ok).toBe(true);
      if (!submitResult.ok) return;

      const getResult = store.get(submitResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).not.toBeNull();
      expect(getResult.value!.rating).toBe(4);
    });

    test("returns null for non-existent id", () => {
      const store = makeStore();
      const result = store.get("nonexistent-id");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // list()
  // -------------------------------------------------------------------------

  describe("list", () => {
    test("returns all feedback ordered by created_at DESC", () => {
      const store = makeStore();
      store.submit({ sessionId: "sess-1", rating: 3, channel: "telegram" });
      store.submit({ sessionId: "sess-1", rating: 5, channel: "telegram" });
      store.submit({ sessionId: "sess-2", rating: 1, channel: "desktop" });

      const result = store.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(3);
      // Most recent first
      expect(result.value[0]!.rating).toBe(1); // sess-2, created last
    });

    test("filters by sessionId", () => {
      const store = makeStore();
      store.submit({ sessionId: "sess-1", rating: 3, channel: "telegram" });
      store.submit({ sessionId: "sess-2", rating: 5, channel: "desktop" });

      const result = store.list({ sessionId: "sess-1" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0]!.sessionId).toBe("sess-1");
    });

    test("respects limit parameter", () => {
      const store = makeStore();
      for (let i = 0; i < 10; i++) {
        store.submit({ sessionId: "sess-1", rating: 3, channel: "telegram" });
      }

      const result = store.list({ limit: 5 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(5);
    });

    test("filters by since timestamp", () => {
      const store = makeStore();
      store.submit({ sessionId: "sess-1", rating: 3, channel: "telegram" });

      // Submit another one slightly later
      const now = Date.now();
      store.submit({ sessionId: "sess-1", rating: 5, channel: "telegram" });

      const result = store.list({ since: now });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Should only return entries created at or after 'now'
      expect(result.value.length).toBeGreaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // getSummary()
  // -------------------------------------------------------------------------

  describe("getSummary", () => {
    test("returns correct summary for mixed ratings", () => {
      const store = makeStore();
      store.submit({ sessionId: "sess-1", rating: 5, channel: "telegram" }); // positive
      store.submit({ sessionId: "sess-1", rating: 4, channel: "telegram" }); // positive
      store.submit({ sessionId: "sess-1", rating: 3, channel: "telegram" }); // neutral
      store.submit({ sessionId: "sess-1", rating: 2, channel: "telegram" }); // negative
      store.submit({ sessionId: "sess-1", rating: 1, channel: "telegram" }); // negative

      const result = store.getSummary();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.count).toBe(5);
      expect(result.value.averageRating).toBeCloseTo(3.0, 1);
      expect(result.value.positiveCount).toBe(2);
      expect(result.value.negativeCount).toBe(2);
    });

    test("returns zeroes for empty dataset", () => {
      const store = makeStore();
      const result = store.getSummary();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.count).toBe(0);
      expect(result.value.averageRating).toBe(0);
      expect(result.value.positiveCount).toBe(0);
      expect(result.value.negativeCount).toBe(0);
    });

    test("filters summary by sessionId", () => {
      const store = makeStore();
      store.submit({ sessionId: "sess-1", rating: 5, channel: "telegram" });
      store.submit({ sessionId: "sess-2", rating: 1, channel: "desktop" });

      const result = store.getSummary({ sessionId: "sess-1" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.count).toBe(1);
      expect(result.value.averageRating).toBeCloseTo(5.0, 1);
      expect(result.value.positiveCount).toBe(1);
      expect(result.value.negativeCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // confidenceAdjustment()
  // -------------------------------------------------------------------------

  describe("confidenceAdjustment", () => {
    test("returns positive adjustment for rating 5", () => {
      expect(FeedbackStore.confidenceAdjustment(5)).toBe(CONFIDENCE_ADJUSTMENT);
    });

    test("returns positive adjustment for rating 4", () => {
      expect(FeedbackStore.confidenceAdjustment(4)).toBe(CONFIDENCE_ADJUSTMENT);
    });

    test("returns zero for neutral rating 3", () => {
      expect(FeedbackStore.confidenceAdjustment(3)).toBe(0);
    });

    test("returns negative adjustment for rating 2", () => {
      expect(FeedbackStore.confidenceAdjustment(2)).toBe(-CONFIDENCE_ADJUSTMENT);
    });

    test("returns negative adjustment for rating 1", () => {
      expect(FeedbackStore.confidenceAdjustment(1)).toBe(-CONFIDENCE_ADJUSTMENT);
    });
  });
});
