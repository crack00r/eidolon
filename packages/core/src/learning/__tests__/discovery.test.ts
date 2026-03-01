import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.js";
import { DiscoveryEngine } from "../discovery.js";

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
    CREATE TABLE discoveries (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      relevance_score REAL NOT NULL,
      safety_level TEXT NOT NULL CHECK(safety_level IN ('safe','needs_approval','dangerous')),
      status TEXT NOT NULL CHECK(status IN ('new','evaluated','approved','rejected','implemented')),
      implementation_branch TEXT,
      created_at INTEGER NOT NULL,
      evaluated_at INTEGER,
      implemented_at INTEGER
    );
    CREATE INDEX idx_discoveries_status ON discoveries(status);
  `);
  return db;
}

describe("DiscoveryEngine", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function makeEngine(): DiscoveryEngine {
    const db = createTestDb();
    databases.push(db);
    return new DiscoveryEngine(db, logger);
  }

  test("create stores discovery", () => {
    const engine = makeEngine();

    const result = engine.create({
      sourceType: "hackernews",
      url: "https://example.com/article",
      title: "Test Article",
      content: "Some content about TypeScript.",
      relevanceScore: 0.8,
      safetyLevel: "safe",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceType).toBe("hackernews");
      expect(result.value.url).toBe("https://example.com/article");
      expect(result.value.title).toBe("Test Article");
      expect(result.value.content).toBe("Some content about TypeScript.");
      expect(result.value.relevanceScore).toBe(0.8);
      expect(result.value.safetyLevel).toBe("safe");
      expect(result.value.status).toBe("new");
      expect(result.value.id).toBeDefined();
      expect(result.value.createdAt).toBeGreaterThan(0);
    }
  });

  test("get returns discovery by ID", () => {
    const engine = makeEngine();

    const createResult = engine.create({
      sourceType: "reddit",
      url: "https://reddit.com/r/test",
      title: "Reddit Post",
      content: "Content here.",
      relevanceScore: 0.7,
      safetyLevel: "needs_approval",
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const getResult = engine.get(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).not.toBeNull();
      expect(getResult.value?.title).toBe("Reddit Post");
      expect(getResult.value?.sourceType).toBe("reddit");
    }
  });

  test("isKnown returns true for existing URL", () => {
    const engine = makeEngine();

    engine.create({
      sourceType: "hackernews",
      url: "https://example.com/known",
      title: "Known",
      content: "Content.",
      relevanceScore: 0.5,
      safetyLevel: "safe",
    });

    const result = engine.isKnown("https://example.com/known");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true);
    }
  });

  test("isKnown returns false for unknown URL", () => {
    const engine = makeEngine();

    const result = engine.isKnown("https://example.com/unknown");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(false);
    }
  });

  test("listByStatus filters correctly", () => {
    const engine = makeEngine();

    engine.create({
      sourceType: "hackernews",
      url: "https://example.com/1",
      title: "First",
      content: "Content.",
      relevanceScore: 0.5,
      safetyLevel: "safe",
    });

    engine.create({
      sourceType: "reddit",
      url: "https://example.com/2",
      title: "Second",
      content: "Content.",
      relevanceScore: 0.6,
      safetyLevel: "safe",
    });

    // Both should be "new"
    const newResult = engine.listByStatus("new");
    expect(newResult.ok).toBe(true);
    if (newResult.ok) {
      expect(newResult.value).toHaveLength(2);
    }

    // None should be "evaluated"
    const evalResult = engine.listByStatus("evaluated");
    expect(evalResult.ok).toBe(true);
    if (evalResult.ok) {
      expect(evalResult.value).toHaveLength(0);
    }
  });

  test("updateStatus changes status", () => {
    const engine = makeEngine();

    const createResult = engine.create({
      sourceType: "github",
      url: "https://github.com/example/repo",
      title: "Repo",
      content: "A repository.",
      relevanceScore: 0.9,
      safetyLevel: "needs_approval",
    });

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const id = createResult.value.id;
    const updateResult = engine.updateStatus(id, "evaluated");
    expect(updateResult.ok).toBe(true);

    const getResult = engine.get(id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok && getResult.value) {
      expect(getResult.value.status).toBe("evaluated");
      expect(getResult.value.evaluatedAt).toBeDefined();
      expect(getResult.value.evaluatedAt).toBeGreaterThan(0);
    }
  });

  test("countToday counts today's discoveries", () => {
    const engine = makeEngine();

    // Create 3 discoveries (all created "now" = today)
    engine.create({
      sourceType: "hackernews",
      url: "https://example.com/a",
      title: "A",
      content: "C.",
      relevanceScore: 0.5,
      safetyLevel: "safe",
    });
    engine.create({
      sourceType: "hackernews",
      url: "https://example.com/b",
      title: "B",
      content: "C.",
      relevanceScore: 0.5,
      safetyLevel: "safe",
    });
    engine.create({
      sourceType: "hackernews",
      url: "https://example.com/c",
      title: "C",
      content: "C.",
      relevanceScore: 0.5,
      safetyLevel: "safe",
    });

    const result = engine.countToday();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(3);
    }
  });

  test("getStats returns correct statistics", () => {
    const engine = makeEngine();

    engine.create({
      sourceType: "hackernews",
      url: "https://example.com/s1",
      title: "S1",
      content: "C.",
      relevanceScore: 0.5,
      safetyLevel: "safe",
    });
    engine.create({
      sourceType: "reddit",
      url: "https://example.com/s2",
      title: "S2",
      content: "C.",
      relevanceScore: 0.6,
      safetyLevel: "safe",
    });

    // Update one to "evaluated"
    const listResult = engine.listByStatus("new");
    if (listResult.ok && listResult.value.length > 0) {
      const first = listResult.value[0];
      if (first) {
        engine.updateStatus(first.id, "evaluated");
      }
    }

    const statsResult = engine.getStats();
    expect(statsResult.ok).toBe(true);
    if (statsResult.ok) {
      expect(statsResult.value.total).toBe(2);
      expect(statsResult.value.byStatus.new).toBe(1);
      expect(statsResult.value.byStatus.evaluated).toBe(1);
    }
  });
});
