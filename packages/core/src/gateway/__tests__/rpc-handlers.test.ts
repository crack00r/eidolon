/**
 * Tests for core RPC handler factories in rpc-handlers.ts.
 *
 * Each handler is tested directly (not through WebSocket) by calling
 * the returned MethodHandler function with params and a clientId.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { MemorySearchResult } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { HealthChecker } from "../../health/checker.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import type { MemorySearch } from "../../memory/search.ts";
import type { MemoryStore } from "../../memory/store.ts";
import {
  type CoreRpcDeps,
  createChatSendHandler,
  createChatStreamHandler,
  createCoreRpcHandlers,
  createLearningApproveHandler,
  createLearningListHandler,
  createLearningRejectHandler,
  createMemoryDeleteHandler,
  createMemorySearchHandler,
  createSessionInfoHandler,
  createSessionListHandler,
  createSystemHealthHandler,
  createSystemStatusHandler,
  createVoiceStartHandler,
  createVoiceStopHandler,
} from "../rpc-handlers.ts";

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

const logger = createSilentLogger();

function createTestEventBus(): EventBus {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      payload TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'system',
      timestamp INTEGER NOT NULL,
      processed_at INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  return new EventBus(db, logger);
}

function createOperationalDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      claude_session_id TEXT,
      started_at INTEGER NOT NULL,
      last_activity_at INTEGER NOT NULL,
      completed_at INTEGER,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      metadata TEXT DEFAULT '{}'
    )
  `);
  db.run(`
    CREATE TABLE discoveries (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      relevance_score REAL NOT NULL,
      safety_level TEXT NOT NULL,
      status TEXT NOT NULL,
      implementation_branch TEXT,
      created_at INTEGER NOT NULL,
      evaluated_at INTEGER,
      implemented_at INTEGER
    )
  `);
  return db;
}

function createMockMemorySearch(results: MemorySearchResult[] = [], shouldFail = false): MemorySearch {
  return {
    search: async () => {
      if (shouldFail) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, "Search failed"));
      }
      return Ok(results);
    },
  } as unknown as MemorySearch;
}

function createMockMemoryStore(opts?: {
  countValue?: number;
  deleteOk?: boolean;
  deleteNotFound?: boolean;
}): MemoryStore {
  const countValue = opts?.countValue ?? 42;
  const deleteOk = opts?.deleteOk ?? true;
  const deleteNotFound = opts?.deleteNotFound ?? false;

  return {
    count: () => Ok(countValue),
    delete: (_id: string) => {
      if (deleteNotFound) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, "Memory not found"));
      }
      if (!deleteOk) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, "Delete failed"));
      }
      return Ok(undefined);
    },
  } as unknown as MemoryStore;
}

function createMockHealthChecker(status = "healthy"): HealthChecker {
  return {
    check: async () => ({
      status,
      timestamp: Date.now(),
      uptime: 1000,
      checks: [{ name: "database", status: "pass", message: "OK" }],
    }),
  } as unknown as HealthChecker;
}

function makeDeps(overrides?: Partial<CoreRpcDeps>): CoreRpcDeps {
  return {
    logger,
    eventBus: createTestEventBus(),
    operationalDb: createOperationalDb(),
    memorySearch: createMockMemorySearch(),
    memoryStore: createMockMemoryStore(),
    healthChecker: createMockHealthChecker(),
    startTime: Date.now() - 60_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// chat.send
// ---------------------------------------------------------------------------

describe("createChatSendHandler", () => {
  test("queues a message and returns messageId", async () => {
    const deps = makeDeps();
    const handler = createChatSendHandler(deps);

    const result = (await handler({ text: "Hello world" }, "client-1")) as Record<string, unknown>;

    expect(result.status).toBe("queued");
    expect(typeof result.messageId).toBe("string");
    expect((result.messageId as string).length).toBeGreaterThan(0);
  });

  test("uses provided channelId", async () => {
    const deps = makeDeps();
    const handler = createChatSendHandler(deps);

    const result = (await handler({ text: "Hi", channelId: "telegram" }, "c1")) as Record<string, unknown>;
    expect(result.status).toBe("queued");
  });

  test("rejects empty text", async () => {
    const handler = createChatSendHandler(makeDeps());
    await expect(handler({ text: "" }, "c1")).rejects.toThrow();
  });

  test("rejects missing text", async () => {
    const handler = createChatSendHandler(makeDeps());
    await expect(handler({}, "c1")).rejects.toThrow();
  });

  test("rejects text exceeding max length", async () => {
    const handler = createChatSendHandler(makeDeps());
    const longText = "a".repeat(100_001);
    await expect(handler({ text: longText }, "c1")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// chat.stream
// ---------------------------------------------------------------------------

describe("createChatStreamHandler", () => {
  test("returns messageId and streamId", async () => {
    const handler = createChatStreamHandler(makeDeps());

    const result = (await handler({ text: "Stream me" }, "c1")) as Record<string, unknown>;

    expect(result.status).toBe("streaming");
    expect(typeof result.messageId).toBe("string");
    expect(typeof result.streamId).toBe("string");
    expect(result.messageId).not.toBe(result.streamId);
  });

  test("rejects invalid params", async () => {
    const handler = createChatStreamHandler(makeDeps());
    await expect(handler({ text: 123 }, "c1")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// memory.search
// ---------------------------------------------------------------------------

describe("createMemorySearchHandler", () => {
  test("returns search results", async () => {
    const mockResult: MemorySearchResult = {
      memory: {
        id: "mem-1",
        type: "fact",
        layer: "long_term",
        content: "TypeScript is preferred",
        confidence: 0.9,
        source: "conversation",
        tags: ["tech"],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 1,
      },
      score: 0.85,
      bm25Score: 0.7,
      vectorScore: 0.9,
      graphScore: 0.1,
      matchReason: "semantic match",
    };

    const deps = makeDeps({
      memorySearch: createMockMemorySearch([mockResult]),
    });
    const handler = createMemorySearchHandler(deps);

    const result = (await handler({ query: "TypeScript" }, "c1")) as Record<string, unknown>;

    expect(result.total).toBe(1);
    const results = result.results as Array<Record<string, unknown>>;
    expect(results[0]?.id).toBe("mem-1");
    expect(results[0]?.content).toBe("TypeScript is preferred");
    expect(results[0]?.score).toBe(0.85);
  });

  test("throws when memorySearch is unavailable", async () => {
    const handler = createMemorySearchHandler(makeDeps({ memorySearch: undefined }));
    await expect(handler({ query: "test" }, "c1")).rejects.toThrow("Memory search is not available");
  });

  test("throws on search failure", async () => {
    const deps = makeDeps({
      memorySearch: createMockMemorySearch([], true),
    });
    const handler = createMemorySearchHandler(deps);
    await expect(handler({ query: "test" }, "c1")).rejects.toThrow("Search failed");
  });

  test("rejects invalid params (missing query)", async () => {
    const handler = createMemorySearchHandler(makeDeps());
    await expect(handler({}, "c1")).rejects.toThrow();
  });

  test("rejects query exceeding max length", async () => {
    const handler = createMemorySearchHandler(makeDeps());
    await expect(handler({ query: "x".repeat(4097) }, "c1")).rejects.toThrow();
  });

  test("accepts optional filter params", async () => {
    const deps = makeDeps({ memorySearch: createMockMemorySearch([]) });
    const handler = createMemorySearchHandler(deps);

    const result = (await handler({ query: "test", limit: 5, types: ["fact"], minConfidence: 0.8 }, "c1")) as Record<
      string,
      unknown
    >;

    expect(result.total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// memory.delete
// ---------------------------------------------------------------------------

describe("createMemoryDeleteHandler", () => {
  test("deletes a memory by ID", async () => {
    const handler = createMemoryDeleteHandler(makeDeps());

    const result = (await handler({ id: "mem-1" }, "c1")) as Record<string, unknown>;

    expect(result.deleted).toBe(true);
    expect(result.id).toBe("mem-1");
  });

  test("throws when memoryStore is unavailable", async () => {
    const handler = createMemoryDeleteHandler(makeDeps({ memoryStore: undefined }));
    await expect(handler({ id: "mem-1" }, "c1")).rejects.toThrow("Memory store is not available");
  });

  test("throws on delete failure", async () => {
    const deps = makeDeps({
      memoryStore: createMockMemoryStore({ deleteNotFound: true }),
    });
    const handler = createMemoryDeleteHandler(deps);
    await expect(handler({ id: "nonexistent" }, "c1")).rejects.toThrow();
  });

  test("rejects missing id", async () => {
    const handler = createMemoryDeleteHandler(makeDeps());
    await expect(handler({}, "c1")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// session.list
// ---------------------------------------------------------------------------

describe("createSessionListHandler", () => {
  test("returns empty list when no sessions exist", async () => {
    const handler = createSessionListHandler(makeDeps());

    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.total).toBe(0);
    expect(result.sessions).toEqual([]);
  });

  test("returns sessions from the database", async () => {
    const db = createOperationalDb();
    db.run(
      "INSERT INTO sessions (id, type, status, started_at, last_activity_at, tokens_used, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["s-1", "main", "running", Date.now() - 10000, Date.now(), 500, 0.02],
    );
    db.run(
      "INSERT INTO sessions (id, type, status, started_at, last_activity_at, tokens_used, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["s-2", "task", "completed", Date.now() - 20000, Date.now() - 5000, 200, 0.01],
    );

    const handler = createSessionListHandler(makeDeps({ operationalDb: db }));
    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.total).toBe(2);
    const sessions = result.sessions as Array<Record<string, unknown>>;
    expect(sessions[0]?.id).toBe("s-1"); // most recent first
  });

  test("filters by status", async () => {
    const db = createOperationalDb();
    db.run(
      "INSERT INTO sessions (id, type, status, started_at, last_activity_at, tokens_used, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["s-1", "main", "running", Date.now(), Date.now(), 0, 0],
    );
    db.run(
      "INSERT INTO sessions (id, type, status, started_at, last_activity_at, tokens_used, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["s-2", "task", "completed", Date.now(), Date.now(), 0, 0],
    );

    const handler = createSessionListHandler(makeDeps({ operationalDb: db }));
    const result = (await handler({ status: "running" }, "c1")) as Record<string, unknown>;

    expect(result.total).toBe(1);
    const sessions = result.sessions as Array<Record<string, unknown>>;
    expect(sessions[0]?.status).toBe("running");
  });

  test("respects limit param", async () => {
    const db = createOperationalDb();
    for (let i = 0; i < 5; i++) {
      db.run(
        "INSERT INTO sessions (id, type, status, started_at, last_activity_at, tokens_used, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [`s-${i}`, "main", "completed", Date.now() - i * 1000, Date.now() - i * 1000, 0, 0],
      );
    }

    const handler = createSessionListHandler(makeDeps({ operationalDb: db }));
    const result = (await handler({ limit: 2 }, "c1")) as Record<string, unknown>;

    expect(result.total).toBe(2);
  });

  test("throws when operationalDb is unavailable", async () => {
    const handler = createSessionListHandler(makeDeps({ operationalDb: undefined }));
    await expect(handler({}, "c1")).rejects.toThrow("Operational database is not available");
  });
});

// ---------------------------------------------------------------------------
// session.info
// ---------------------------------------------------------------------------

describe("createSessionInfoHandler", () => {
  test("returns session details", async () => {
    const db = createOperationalDb();
    const now = Date.now();
    db.run(
      "INSERT INTO sessions (id, type, status, started_at, last_activity_at, tokens_used, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["s-1", "main", "running", now - 5000, now, 300, 0.015],
    );

    const handler = createSessionInfoHandler(makeDeps({ operationalDb: db }));
    const result = (await handler({ sessionId: "s-1" }, "c1")) as Record<string, unknown>;

    const session = result.session as Record<string, unknown>;
    expect(session.id).toBe("s-1");
    expect(session.type).toBe("main");
    expect(session.status).toBe("running");
    expect(session.tokensUsed).toBe(300);
  });

  test("throws when session not found", async () => {
    const handler = createSessionInfoHandler(makeDeps());
    await expect(handler({ sessionId: "nonexistent" }, "c1")).rejects.toThrow("Session not found");
  });

  test("throws when operationalDb is unavailable", async () => {
    const handler = createSessionInfoHandler(makeDeps({ operationalDb: undefined }));
    await expect(handler({ sessionId: "s-1" }, "c1")).rejects.toThrow("Operational database is not available");
  });

  test("rejects missing sessionId", async () => {
    const handler = createSessionInfoHandler(makeDeps());
    await expect(handler({}, "c1")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// learning.list
// ---------------------------------------------------------------------------

describe("createLearningListHandler", () => {
  test("returns empty list when no discoveries exist", async () => {
    const handler = createLearningListHandler(makeDeps());

    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.total).toBe(0);
    expect(result.discoveries).toEqual([]);
  });

  test("returns discoveries from the database", async () => {
    const db = createOperationalDb();
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-1", "reddit", "https://reddit.com/123", "sqlite-vec 0.2.0", "New release", 0.85, "safe", "new", Date.now()],
    );

    const handler = createLearningListHandler(makeDeps({ operationalDb: db }));
    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.total).toBe(1);
    const discoveries = result.discoveries as Array<Record<string, unknown>>;
    expect(discoveries[0]?.id).toBe("d-1");
    expect(discoveries[0]?.title).toBe("sqlite-vec 0.2.0");
    expect(discoveries[0]?.sourceType).toBe("reddit");
  });

  test("filters by status", async () => {
    const db = createOperationalDb();
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-1", "reddit", "https://r.com/1", "Title 1", "C1", 0.8, "safe", "new", Date.now()],
    );
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-2", "hackernews", "https://hn.com/2", "Title 2", "C2", 0.7, "needs_approval", "approved", Date.now()],
    );

    const handler = createLearningListHandler(makeDeps({ operationalDb: db }));
    const result = (await handler({ status: "new" }, "c1")) as Record<string, unknown>;

    expect(result.total).toBe(1);
  });

  test("throws when operationalDb is unavailable", async () => {
    const handler = createLearningListHandler(makeDeps({ operationalDb: undefined }));
    await expect(handler({}, "c1")).rejects.toThrow("Operational database is not available");
  });
});

// ---------------------------------------------------------------------------
// learning.approve
// ---------------------------------------------------------------------------

describe("createLearningApproveHandler", () => {
  test("approves a discovery with 'new' status", async () => {
    const db = createOperationalDb();
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-1", "reddit", "https://r.com/1", "sqlite-vec", "content", 0.85, "safe", "new", Date.now()],
    );

    const deps = makeDeps({ operationalDb: db });
    const handler = createLearningApproveHandler(deps);

    const result = (await handler({ discoveryId: "d-1" }, "c1")) as Record<string, unknown>;

    expect(result.approved).toBe(true);
    expect(result.discoveryId).toBe("d-1");

    // Verify database was updated
    const row = db.query("SELECT status FROM discoveries WHERE id = ?").get("d-1") as Record<string, unknown>;
    expect(row.status).toBe("approved");
  });

  test("approves a discovery with 'evaluated' status", async () => {
    const db = createOperationalDb();
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-1", "reddit", "https://r.com/1", "Title", "content", 0.85, "safe", "evaluated", Date.now()],
    );

    const handler = createLearningApproveHandler(makeDeps({ operationalDb: db }));
    const result = (await handler({ discoveryId: "d-1" }, "c1")) as Record<string, unknown>;

    expect(result.approved).toBe(true);
  });

  test("rejects approval of already-approved discovery", async () => {
    const db = createOperationalDb();
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-1", "reddit", "https://r.com/1", "Title", "content", 0.85, "safe", "approved", Date.now()],
    );

    const handler = createLearningApproveHandler(makeDeps({ operationalDb: db }));
    await expect(handler({ discoveryId: "d-1" }, "c1")).rejects.toThrow("cannot be approved");
  });

  test("throws when discovery not found", async () => {
    const handler = createLearningApproveHandler(makeDeps());
    await expect(handler({ discoveryId: "nonexistent" }, "c1")).rejects.toThrow("Discovery not found");
  });

  test("throws when operationalDb is unavailable", async () => {
    const handler = createLearningApproveHandler(makeDeps({ operationalDb: undefined }));
    await expect(handler({ discoveryId: "d-1" }, "c1")).rejects.toThrow();
  });

  test("publishes learning:approved event", async () => {
    const db = createOperationalDb();
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-1", "reddit", "https://r.com/1", "sqlite-vec", "content", 0.85, "safe", "new", Date.now()],
    );

    const eventBus = createTestEventBus();
    let receivedEvent = false;
    eventBus.subscribe("learning:approved", () => {
      receivedEvent = true;
    });

    const handler = createLearningApproveHandler(makeDeps({ operationalDb: db, eventBus }));
    await handler({ discoveryId: "d-1" }, "c1");

    expect(receivedEvent).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// learning.reject
// ---------------------------------------------------------------------------

describe("createLearningRejectHandler", () => {
  test("rejects a discovery", async () => {
    const db = createOperationalDb();
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-1", "reddit", "https://r.com/1", "Title", "content", 0.5, "safe", "new", Date.now()],
    );

    const handler = createLearningRejectHandler(makeDeps({ operationalDb: db }));

    const result = (await handler({ discoveryId: "d-1", reason: "Not relevant" }, "c1")) as Record<string, unknown>;

    expect(result.rejected).toBe(true);
    expect(result.discoveryId).toBe("d-1");

    const row = db.query("SELECT status FROM discoveries WHERE id = ?").get("d-1") as Record<string, unknown>;
    expect(row.status).toBe("rejected");
  });

  test("rejects without a reason", async () => {
    const db = createOperationalDb();
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-1", "reddit", "https://r.com/1", "Title", "content", 0.5, "safe", "evaluated", Date.now()],
    );

    const handler = createLearningRejectHandler(makeDeps({ operationalDb: db }));
    const result = (await handler({ discoveryId: "d-1" }, "c1")) as Record<string, unknown>;

    expect(result.rejected).toBe(true);
  });

  test("throws for already-rejected discovery", async () => {
    const db = createOperationalDb();
    db.run(
      `INSERT INTO discoveries (id, source_type, url, title, content, relevance_score, safety_level, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["d-1", "reddit", "https://r.com/1", "Title", "content", 0.5, "safe", "rejected", Date.now()],
    );

    const handler = createLearningRejectHandler(makeDeps({ operationalDb: db }));
    await expect(handler({ discoveryId: "d-1" }, "c1")).rejects.toThrow("cannot be rejected");
  });

  test("throws when discovery not found", async () => {
    const handler = createLearningRejectHandler(makeDeps());
    await expect(handler({ discoveryId: "nope" }, "c1")).rejects.toThrow("Discovery not found");
  });
});

// ---------------------------------------------------------------------------
// system.status
// ---------------------------------------------------------------------------

describe("createSystemStatusHandler", () => {
  test("returns running status with uptime", async () => {
    const startTime = Date.now() - 120_000;
    const handler = createSystemStatusHandler(makeDeps({ startTime }));

    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.state).toBe("running");
    expect(typeof result.uptime).toBe("number");
    expect(result.uptime as number).toBeGreaterThanOrEqual(120_000);
    expect(typeof result.memoryCount).toBe("number");
    expect(typeof result.eventQueueDepth).toBe("number");
  });

  test("works without memoryStore", async () => {
    const handler = createSystemStatusHandler(makeDeps({ memoryStore: undefined }));

    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.state).toBe("running");
    expect(result.memoryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// system.health
// ---------------------------------------------------------------------------

describe("createSystemHealthHandler", () => {
  test("returns health status from HealthChecker", async () => {
    const handler = createSystemHealthHandler(makeDeps());

    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.status).toBe("healthy");
    expect(typeof result.timestamp).toBe("number");
    expect(typeof result.uptimeMs).toBe("number");
    expect(Array.isArray(result.checks)).toBe(true);
  });

  test("returns unknown when HealthChecker is unavailable", async () => {
    const handler = createSystemHealthHandler(makeDeps({ healthChecker: undefined }));

    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.status).toBe("unknown");
    expect(result.note).toBe("HealthChecker not available");
  });
});

// ---------------------------------------------------------------------------
// voice.start
// ---------------------------------------------------------------------------

describe("createVoiceStartHandler", () => {
  test("returns voice session config with defaults", async () => {
    const handler = createVoiceStartHandler(makeDeps());

    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.status).toBe("ready");
    expect(typeof result.sessionId).toBe("string");

    const config = result.config as Record<string, unknown>;
    expect(config.codec).toBe("opus");
    expect(config.sampleRate).toBe(24_000);
    expect(config.channels).toBe(1);
  });

  test("respects provided codec and sampleRate", async () => {
    const handler = createVoiceStartHandler(makeDeps());

    const result = (await handler({ codec: "pcm", sampleRate: 48_000 }, "c1")) as Record<string, unknown>;

    const config = result.config as Record<string, unknown>;
    expect(config.codec).toBe("pcm");
    expect(config.sampleRate).toBe(48_000);
  });

  test("rejects invalid codec", async () => {
    const handler = createVoiceStartHandler(makeDeps());
    await expect(handler({ codec: "mp3" }, "c1")).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// voice.stop
// ---------------------------------------------------------------------------

describe("createVoiceStopHandler", () => {
  test("returns stopped confirmation", async () => {
    const handler = createVoiceStopHandler(makeDeps());

    const result = (await handler({}, "c1")) as Record<string, unknown>;

    expect(result.stopped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createCoreRpcHandlers (bulk registration)
// ---------------------------------------------------------------------------

describe("createCoreRpcHandlers", () => {
  test("registers all 13 expected handlers", () => {
    const handlers = createCoreRpcHandlers(makeDeps());

    const expectedMethods = [
      "chat.send",
      "chat.stream",
      "memory.search",
      "memory.delete",
      "session.list",
      "session.info",
      "learning.list",
      "learning.approve",
      "learning.reject",
      "system.status",
      "system.health",
      "voice.start",
      "voice.stop",
    ];

    for (const method of expectedMethods) {
      expect(handlers.has(method)).toBe(true);
    }

    expect(handlers.size).toBe(expectedMethods.length);
  });

  test("handlers are callable functions", () => {
    const handlers = createCoreRpcHandlers(makeDeps());

    for (const [, handler] of handlers) {
      expect(typeof handler).toBe("function");
    }
  });
});
