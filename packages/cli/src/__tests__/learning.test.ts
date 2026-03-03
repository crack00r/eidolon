/**
 * Tests for eidolon learning CLI commands.
 *
 * Verifies that the DiscoveryEngine and LearningJournal integration
 * used by the learning subcommands works correctly with in-memory SQLite.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DiscoveryEngine } from "../../../core/src/learning/discovery.ts";
import { LearningJournal } from "../../../core/src/learning/journal.ts";
import type { Logger } from "../../../core/src/logging/logger.ts";

// ---------------------------------------------------------------------------
// Test helpers
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

const DISCOVERIES_SCHEMA = `
  CREATE TABLE discoveries (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    normalized_url TEXT,
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
  CREATE INDEX idx_discoveries_normalized_url ON discoveries(normalized_url);
`;

const JOURNAL_SCHEMA = `
  CREATE TABLE learning_journal (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK(type IN ('discovery','evaluation','approval','rejection','implementation','error')),
    timestamp INTEGER NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX idx_learning_journal_timestamp ON learning_journal(timestamp);
  CREATE INDEX idx_learning_journal_type ON learning_journal(type);
`;

function createTestDb(schema: string): Database {
  const db = new Database(":memory:");
  db.exec(schema);
  return db;
}

// ---------------------------------------------------------------------------
// DiscoveryEngine operations (used by status, discoveries, approve, reject)
// ---------------------------------------------------------------------------

describe("learning CLI: DiscoveryEngine operations", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function makeEngine(): DiscoveryEngine {
    const db = createTestDb(DISCOVERIES_SCHEMA);
    databases.push(db);
    return new DiscoveryEngine(db, logger);
  }

  test("getStats returns empty when no discoveries", () => {
    const engine = makeEngine();
    const result = engine.getStats();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.total).toBe(0);
      expect(Object.keys(result.value.byStatus)).toHaveLength(0);
    }
  });

  test("getStats returns status breakdown after creating discoveries", () => {
    const engine = makeEngine();

    engine.create({
      sourceType: "reddit",
      url: "https://example.com/a",
      title: "Article A",
      content: "Content A",
      relevanceScore: 0.8,
      safetyLevel: "safe",
    });
    engine.create({
      sourceType: "hackernews",
      url: "https://example.com/b",
      title: "Article B",
      content: "Content B",
      relevanceScore: 0.9,
      safetyLevel: "needs_approval",
    });

    const result = engine.getStats();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.total).toBe(2);
      expect(result.value.byStatus["new"]).toBe(2);
    }
  });

  test("countToday returns count of discoveries created today", () => {
    const engine = makeEngine();

    engine.create({
      sourceType: "github",
      url: "https://github.com/test/repo",
      title: "Test Repo",
      content: "A test repository",
      relevanceScore: 0.7,
      safetyLevel: "safe",
    });

    const result = engine.countToday();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1);
    }
  });

  test("listByStatus filters correctly", () => {
    const engine = makeEngine();

    const d1 = engine.create({
      sourceType: "reddit",
      url: "https://example.com/1",
      title: "First",
      content: "Content 1",
      relevanceScore: 0.6,
      safetyLevel: "safe",
    });
    expect(d1.ok).toBe(true);

    engine.create({
      sourceType: "reddit",
      url: "https://example.com/2",
      title: "Second",
      content: "Content 2",
      relevanceScore: 0.7,
      safetyLevel: "safe",
    });

    // Move first to evaluated
    if (d1.ok) {
      engine.updateStatus(d1.value.id, "evaluated");
    }

    const newResult = engine.listByStatus("new", 50);
    expect(newResult.ok).toBe(true);
    if (newResult.ok) {
      expect(newResult.value).toHaveLength(1);
      const firstNew = newResult.value[0];
      expect(firstNew).toBeDefined();
      expect(firstNew?.title).toBe("Second");
    }

    const evalResult = engine.listByStatus("evaluated", 50);
    expect(evalResult.ok).toBe(true);
    if (evalResult.ok) {
      expect(evalResult.value).toHaveLength(1);
      const firstEval = evalResult.value[0];
      expect(firstEval).toBeDefined();
      expect(firstEval?.title).toBe("First");
    }
  });

  test("approve workflow: new -> evaluated -> approved", () => {
    const engine = makeEngine();

    const createResult = engine.create({
      sourceType: "reddit",
      url: "https://example.com/approve-test",
      title: "Approvable Discovery",
      content: "Should be approved",
      relevanceScore: 0.85,
      safetyLevel: "needs_approval",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const id = createResult.value.id;

    // Move to evaluated first
    const evalResult = engine.updateStatus(id, "evaluated");
    expect(evalResult.ok).toBe(true);

    // Then approve
    const approveResult = engine.updateStatus(id, "approved");
    expect(approveResult.ok).toBe(true);

    // Verify final state
    const getResult = engine.get(id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok && getResult.value) {
      expect(getResult.value.status).toBe("approved");
    }
  });

  test("reject workflow: new -> rejected", () => {
    const engine = makeEngine();

    const createResult = engine.create({
      sourceType: "hackernews",
      url: "https://example.com/reject-test",
      title: "Rejectable Discovery",
      content: "Should be rejected",
      relevanceScore: 0.3,
      safetyLevel: "safe",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const id = createResult.value.id;

    // Reject directly from new
    const rejectResult = engine.updateStatus(id, "rejected");
    expect(rejectResult.ok).toBe(true);

    // Verify
    const getResult = engine.get(id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok && getResult.value) {
      expect(getResult.value.status).toBe("rejected");
    }
  });

  test("invalid state transition returns error", () => {
    const engine = makeEngine();

    const createResult = engine.create({
      sourceType: "rss",
      url: "https://example.com/invalid-transition",
      title: "Bad Transition",
      content: "Cannot approve from new",
      relevanceScore: 0.5,
      safetyLevel: "safe",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    // Cannot go from new -> approved directly (must go through evaluated)
    const result = engine.updateStatus(createResult.value.id, "approved");
    expect(result.ok).toBe(false);
  });

  test("get non-existent discovery returns null", () => {
    const engine = makeEngine();

    const result = engine.get("non-existent-id");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// LearningJournal operations (used by journal subcommand)
// ---------------------------------------------------------------------------

describe("learning CLI: LearningJournal operations", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  function makeJournal(withDb = true): LearningJournal {
    if (withDb) {
      const db = createTestDb(JOURNAL_SCHEMA);
      databases.push(db);
      return new LearningJournal(logger, { db });
    }
    return new LearningJournal(logger);
  }

  test("empty journal has count 0", () => {
    const journal = makeJournal(false);
    expect(journal.count).toBe(0);
    journal.dispose();
  });

  test("addEntry creates and retrieves entries", () => {
    const journal = makeJournal();

    journal.addEntry("discovery", "Found sqlite-vec 0.2.0", "New release with performance improvements");
    journal.addEntry("evaluation", "Evaluated relevance", "Score: 85/100, relevant to memory search");

    expect(journal.count).toBe(2);

    const recent = journal.getRecent(10);
    expect(recent).toHaveLength(2);
    // Recent returns most recent first
    expect(recent[0]?.type).toBe("evaluation");
    expect(recent[1]?.type).toBe("discovery");

    journal.dispose();
  });

  test("getByType filters correctly", () => {
    const journal = makeJournal();

    journal.addEntry("discovery", "Disc 1", "Content 1");
    journal.addEntry("error", "Error 1", "Something failed");
    journal.addEntry("discovery", "Disc 2", "Content 2");
    journal.addEntry("approval", "Approved 1", "Approved by user");

    const discoveries = journal.getByType("discovery");
    expect(discoveries).toHaveLength(2);
    // Most recent first
    expect(discoveries[0]?.title).toBe("Disc 2");
    expect(discoveries[1]?.title).toBe("Disc 1");

    const errors = journal.getByType("error");
    expect(errors).toHaveLength(1);

    journal.dispose();
  });

  test("toMarkdown produces valid output", () => {
    const journal = makeJournal(false);

    journal.addEntry("discovery", "New Article", "Found an interesting article");
    const md = journal.toMarkdown();

    expect(md).toContain("# Learning Journal");
    expect(md).toContain("Discovery");
    expect(md).toContain("New Article");

    journal.dispose();
  });

  test("persistence: entries survive reload from DB", () => {
    const db = createTestDb(JOURNAL_SCHEMA);
    databases.push(db);

    // Create journal and add entries
    const journal1 = new LearningJournal(logger, { db });
    journal1.addEntry("discovery", "Persisted Entry", "Should survive reload");
    journal1.addEntry("approval", "Approved Entry", "Also persisted");
    journal1.dispose();

    // Create new journal with same DB -- should load existing entries
    const journal2 = new LearningJournal(logger, { db });
    expect(journal2.count).toBe(2);

    const recent = journal2.getRecent(10);
    expect(recent).toHaveLength(2);
    // Check that the entries were loaded (most recent first)
    expect(recent[0]?.title).toBe("Approved Entry");
    expect(recent[1]?.title).toBe("Persisted Entry");

    journal2.dispose();
  });

  test("getRecent respects limit", () => {
    const journal = makeJournal(false);

    for (let i = 0; i < 10; i++) {
      journal.addEntry("discovery", `Entry ${i}`, `Content ${i}`);
    }

    const limited = journal.getRecent(3);
    expect(limited).toHaveLength(3);
    // Should be most recent 3
    expect(limited[0]?.title).toBe("Entry 9");
    expect(limited[1]?.title).toBe("Entry 8");
    expect(limited[2]?.title).toBe("Entry 7");

    journal.dispose();
  });
});

// ---------------------------------------------------------------------------
// End-to-end workflow
// ---------------------------------------------------------------------------

describe("learning CLI: end-to-end workflow", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  test("full discovery lifecycle: create -> evaluate -> approve -> implement", () => {
    const db = createTestDb(DISCOVERIES_SCHEMA);
    databases.push(db);
    const engine = new DiscoveryEngine(db, logger);

    // Create
    const createResult = engine.create({
      sourceType: "github",
      url: "https://github.com/test/new-feature",
      title: "New Feature Library",
      content: "A library that could improve performance",
      relevanceScore: 0.92,
      safetyLevel: "needs_approval",
    });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const id = createResult.value.id;

    // Evaluate
    expect(engine.updateStatus(id, "evaluated").ok).toBe(true);

    // Verify evaluated_at is set
    const afterEval = engine.get(id);
    expect(afterEval.ok).toBe(true);
    if (afterEval.ok && afterEval.value) {
      expect(afterEval.value.status).toBe("evaluated");
      expect(afterEval.value.evaluatedAt).toBeDefined();
    }

    // Approve
    expect(engine.updateStatus(id, "approved").ok).toBe(true);

    // Set implementation branch
    expect(engine.setImplementationBranch(id, "learning/new-feature").ok).toBe(true);

    // Implement
    expect(engine.updateStatus(id, "implemented").ok).toBe(true);

    // Verify final state
    const final = engine.get(id);
    expect(final.ok).toBe(true);
    if (final.ok && final.value) {
      expect(final.value.status).toBe("implemented");
      expect(final.value.implementedAt).toBeDefined();
      expect(final.value.implementationBranch).toBe("learning/new-feature");
    }

    // Stats should reflect the implementation
    const stats = engine.getStats();
    expect(stats.ok).toBe(true);
    if (stats.ok) {
      expect(stats.value.total).toBe(1);
      expect(stats.value.byStatus["implemented"]).toBe(1);
    }
  });

  test("status display summary matches created discoveries", () => {
    const db = createTestDb(DISCOVERIES_SCHEMA);
    databases.push(db);
    const engine = new DiscoveryEngine(db, logger);

    // Create several discoveries in different states
    const urls = [
      "https://example.com/1",
      "https://example.com/2",
      "https://example.com/3",
      "https://example.com/4",
    ];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      if (!url) continue;
      engine.create({
        sourceType: "reddit",
        url,
        title: `Discovery ${i + 1}`,
        content: `Content ${i + 1}`,
        relevanceScore: 0.5 + i * 0.1,
        safetyLevel: "safe",
      });
    }

    // Move some through states
    const list = engine.listByStatus("new", 100);
    expect(list.ok).toBe(true);
    if (!list.ok) return;

    // Evaluate first two
    const first = list.value[0];
    const second = list.value[1];
    const third = list.value[2];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    if (!first || !second || !third) return;
    engine.updateStatus(first.id, "evaluated");
    engine.updateStatus(second.id, "evaluated");
    // Reject third
    engine.updateStatus(third.id, "rejected");

    // Check stats
    const stats = engine.getStats();
    expect(stats.ok).toBe(true);
    if (stats.ok) {
      expect(stats.value.total).toBe(4);
      expect(stats.value.byStatus["new"]).toBe(1);
      expect(stats.value.byStatus["evaluated"]).toBe(2);
      expect(stats.value.byStatus["rejected"]).toBe(1);
    }
  });
});
