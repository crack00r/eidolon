import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../logging/logger.ts";
import { LearningJournal } from "../journal.ts";

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

describe("LearningJournal", () => {
  const logger = createSilentLogger();

  test("addEntry creates entry with correct fields", () => {
    const journal = new LearningJournal(logger);

    const entry = journal.addEntry("discovery", "SQLite optimization", "Found a new WAL mode technique", {
      source: "hackernews",
      relevance: 0.85,
    });

    expect(entry.type).toBe("discovery");
    expect(entry.title).toBe("SQLite optimization");
    expect(entry.content).toBe("Found a new WAL mode technique");
    expect(entry.metadata).toEqual({ source: "hackernews", relevance: 0.85 });
    expect(entry.id).toMatch(/^journal-/);
    expect(typeof entry.timestamp).toBe("number");
    expect(entry.timestamp).toBeGreaterThan(0);
  });

  test("getRecent returns limited entries", () => {
    const journal = new LearningJournal(logger);

    // Add 5 entries
    for (let i = 0; i < 5; i++) {
      journal.addEntry("discovery", `Entry ${i}`, `Content ${i}`);
    }

    // Default limit (10) - should return all 5
    const all = journal.getRecent();
    expect(all).toHaveLength(5);

    // Limited to 3 - should return the 3 most recent
    const recent = journal.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0]?.title).toBe("Entry 4"); // most recent first
    expect(recent[1]?.title).toBe("Entry 3");
    expect(recent[2]?.title).toBe("Entry 2");
  });

  test("getByType filters correctly", () => {
    const journal = new LearningJournal(logger);

    journal.addEntry("discovery", "Disc 1", "Content");
    journal.addEntry("evaluation", "Eval 1", "Content");
    journal.addEntry("discovery", "Disc 2", "Content");
    journal.addEntry("implementation", "Impl 1", "Content");
    journal.addEntry("error", "Err 1", "Content");

    const discoveries = journal.getByType("discovery");
    expect(discoveries).toHaveLength(2);
    expect(discoveries[0]?.title).toBe("Disc 2"); // most recent first
    expect(discoveries[1]?.title).toBe("Disc 1");

    const evaluations = journal.getByType("evaluation");
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.title).toBe("Eval 1");

    const approvals = journal.getByType("approval");
    expect(approvals).toHaveLength(0);
  });

  test("toMarkdown produces valid markdown", () => {
    const journal = new LearningJournal(logger);

    journal.addEntry("discovery", "New optimization", "Source: HN", {
      relevance: 0.85,
    });
    journal.addEntry("evaluation", "Evaluated optimization", "Safe to apply", {
      safety: "needs_approval",
    });

    const md = journal.toMarkdown();

    expect(md).toContain("# Learning Journal");
    expect(md).toContain("Discovery");
    expect(md).toContain('"New optimization"');
    expect(md).toContain("Evaluation");
    expect(md).toContain('"Evaluated optimization"');
    expect(md).toContain("relevance: 0.85");
    expect(md).toContain("safety: needs_approval");

    // Should not contain "No entries yet" since we have entries
    expect(md).not.toContain("No entries yet");
  });

  test("toMarkdown handles empty journal", () => {
    const journal = new LearningJournal(logger);
    const md = journal.toMarkdown();

    expect(md).toContain("# Learning Journal");
    expect(md).toContain("No entries yet");
  });

  test("count returns correct count", () => {
    const journal = new LearningJournal(logger);

    expect(journal.count).toBe(0);

    journal.addEntry("discovery", "A", "B");
    expect(journal.count).toBe(1);

    journal.addEntry("error", "C", "D");
    expect(journal.count).toBe(2);

    journal.addEntry("implementation", "E", "F");
    expect(journal.count).toBe(3);
  });

  test("clear removes all entries", () => {
    const journal = new LearningJournal(logger);

    journal.addEntry("discovery", "A", "B");
    journal.addEntry("evaluation", "C", "D");
    journal.addEntry("implementation", "E", "F");
    expect(journal.count).toBe(3);

    journal.clear();
    expect(journal.count).toBe(0);
    expect(journal.getRecent()).toHaveLength(0);
    expect(journal.getByType("discovery")).toHaveLength(0);
  });

  test("evicts oldest entries when maxEntries exceeded", () => {
    const journal = new LearningJournal(logger, 3);

    journal.addEntry("discovery", "Entry 1", "Content 1");
    journal.addEntry("discovery", "Entry 2", "Content 2");
    journal.addEntry("discovery", "Entry 3", "Content 3");
    expect(journal.count).toBe(3);

    // Adding a 4th entry should evict the oldest
    journal.addEntry("discovery", "Entry 4", "Content 4");
    expect(journal.count).toBe(3);

    const recent = journal.getRecent(10);
    expect(recent).toHaveLength(3);
    // Entry 1 should have been evicted
    expect(recent.map((e) => e.title)).not.toContain("Entry 1");
    expect(recent[0]?.title).toBe("Entry 4");
  });
});

// ---------------------------------------------------------------------------
// exportToFile
// ---------------------------------------------------------------------------

describe("LearningJournal.exportToFile", () => {
  const logger = createSilentLogger();

  function makeTempDir(): string {
    const dir = join(tmpdir(), `eidolon-journal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    return dir;
  }

  test("writes a markdown file with grouped entries", () => {
    const journal = new LearningJournal(logger);
    const dir = makeTempDir();

    try {
      journal.addEntry("discovery", "Found sqlite-vec 0.2", "From Reddit", { score: 85 });
      journal.addEntry("approval", "Approved sqlite-vec", "User approved via CLI");
      journal.addEntry("implementation", "Implemented sqlite-vec", "Updated dep", { branch: "learning/sqlite-vec" });
      journal.addEntry("error", "Lint failed", "biome returned 2 errors");

      const filePath = journal.exportToFile(dir, "test-export.md");

      expect(filePath).not.toBeNull();
      expect(existsSync(filePath as string)).toBe(true);

      const content = readFileSync(filePath as string, "utf-8");
      expect(content).toContain("# Learning Journal");
      expect(content).toContain("Discoveries (1 items)");
      expect(content).toContain("Approvals");
      expect(content).toContain("Implementations");
      expect(content).toContain("Errors");
      expect(content).toContain("sqlite\\-vec");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns null when no entries match the date", () => {
    const journal = new LearningJournal(logger);
    const dir = makeTempDir();

    try {
      // No entries added, default filename filters by today
      const filePath = journal.exportToFile(dir);
      expect(filePath).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("includes token usage summary from metadata", () => {
    const journal = new LearningJournal(logger);
    const dir = makeTempDir();

    try {
      journal.addEntry("discovery", "Item A", "Content", { tokensUsed: 500 });
      journal.addEntry("implementation", "Item B", "Content", { tokensUsed: 3000 });

      const filePath = journal.exportToFile(dir, "tokens.md");
      expect(filePath).not.toBeNull();

      const content = readFileSync(filePath as string, "utf-8");
      expect(content).toContain("Token Usage");
      expect(content).toContain("3500 tokens");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates nested directories if needed", () => {
    const journal = new LearningJournal(logger);
    const dir = join(makeTempDir(), "nested", "deep");

    try {
      journal.addEntry("discovery", "Test", "Content");

      const filePath = journal.exportToFile(dir, "nested-test.md");
      expect(filePath).not.toBeNull();
      expect(existsSync(filePath as string)).toBe(true);
    } finally {
      // Clean up from the top-level temp dir
      const topDir = dir.split("/nested/")[0];
      if (topDir) {
        rmSync(topDir, { recursive: true, force: true });
      }
    }
  });
});
