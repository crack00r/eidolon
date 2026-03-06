import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import { DocumentIndexer } from "../document-indexer.ts";
import { DocumentWatcher } from "../document-watcher.ts";
import { MemoryStore } from "../store.ts";

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
  db.exec("PRAGMA foreign_keys=ON");
  const result = runMigrations(db, "memory", MEMORY_MIGRATIONS, createSilentLogger());
  if (!result.ok) {
    throw new Error(`Migration failed: ${result.error.message}`);
  }
  return db;
}

/** Wait for a condition to become true, polling every intervalMs. */
async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 100): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

function countMemories(db: Database): number {
  const row = db.query("SELECT COUNT(*) as count FROM memories").get() as { count: number };
  return row.count;
}

function countMemoriesForSource(db: Database, source: string): number {
  const row = db.query("SELECT COUNT(*) as count FROM memories WHERE source = ?").get(source) as { count: number };
  return row.count;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `eidolon-doc-watcher-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DocumentWatcher", () => {
  let db: Database;
  let store: MemoryStore;
  let indexer: DocumentIndexer;
  let watcher: DocumentWatcher;
  const logger = createSilentLogger();

  beforeEach(() => {
    db = createTestDb();
    store = new MemoryStore(db, logger);
    indexer = new DocumentIndexer(db, store, logger);
  });

  afterEach(() => {
    if (watcher?.isWatching) {
      watcher.stopWatching();
    }
    db.close();
  });

  test("starts and stops watching without errors", () => {
    watcher = new DocumentWatcher(indexer, logger);

    expect(watcher.isWatching).toBe(false);

    watcher.startWatching([tempDir]);
    expect(watcher.isWatching).toBe(true);

    watcher.stopWatching();
    expect(watcher.isWatching).toBe(false);
  });

  test("calling startWatching twice stops previous watchers first", () => {
    watcher = new DocumentWatcher(indexer, logger);

    watcher.startWatching([tempDir]);
    expect(watcher.isWatching).toBe(true);

    // Calling again should be safe (idempotent)
    watcher.startWatching([tempDir]);
    expect(watcher.isWatching).toBe(true);

    watcher.stopWatching();
    expect(watcher.isWatching).toBe(false);
  });

  test("handles non-existent directory gracefully", () => {
    watcher = new DocumentWatcher(indexer, logger);
    const badDir = join(tempDir, "does-not-exist");

    // Should not throw
    watcher.startWatching([badDir]);
    expect(watcher.isWatching).toBe(true);

    watcher.stopWatching();
  });

  test("indexes a new file when created in watched directory", async () => {
    // Use a short debounce for faster testing
    watcher = new DocumentWatcher(indexer, logger, {
      debounceMs: 100,
      fileTypes: [".md"],
      exclude: ["node_modules"],
    });

    watcher.startWatching([tempDir]);

    // Create a new file
    const filePath = join(tempDir, `new-file-${Date.now()}.md`);
    writeFileSync(filePath, "# Test\n\nSome content about TypeScript.");

    // Wait for the debounced re-index to happen
    await waitFor(() => countMemories(db) > 0, 3000);

    const count = countMemories(db);
    expect(count).toBeGreaterThan(0);
  });

  test("re-indexes a modified file", async () => {
    // First, create and index a file
    const filePath = join(tempDir, `modify-test-${Date.now()}.md`);
    writeFileSync(filePath, "# Original\n\nOriginal content.");

    const initResult = indexer.indexFile(filePath);
    expect(initResult.ok).toBe(true);
    const initialCount = countMemories(db);
    expect(initialCount).toBeGreaterThan(0);

    // Start watching with short debounce
    watcher = new DocumentWatcher(indexer, logger, {
      debounceMs: 100,
      fileTypes: [".md"],
    });
    watcher.startWatching([tempDir]);

    // Modify the file
    writeFileSync(filePath, "# Updated\n\nUpdated content with more details.\n\n# Section Two\n\nMore text here.");

    // Wait for re-index
    await waitFor(() => {
      const newCount = countMemories(db);
      return newCount !== initialCount;
    }, 3000);

    // File was re-indexed (old chunks removed, new ones added)
    const finalCount = countMemories(db);
    expect(finalCount).toBeGreaterThan(0);
  });

  test("removes indexed chunks when a file is deleted", async () => {
    // Create and index a file
    const filePath = join(tempDir, `delete-test-${Date.now()}.md`);
    writeFileSync(filePath, "# Delete Me\n\nThis file will be deleted.");

    const initResult = indexer.indexFile(filePath);
    expect(initResult.ok).toBe(true);
    expect(countMemories(db)).toBeGreaterThan(0);

    // Start watching
    watcher = new DocumentWatcher(indexer, logger, {
      debounceMs: 100,
      fileTypes: [".md"],
    });
    watcher.startWatching([tempDir]);

    // Delete the file
    unlinkSync(filePath);

    // Wait for removal
    await waitFor(() => {
      const sourceTag = `document:${filePath}`;
      return countMemoriesForSource(db, sourceTag) === 0;
    }, 3000);

    const sourceTag = `document:${filePath}`;
    expect(countMemoriesForSource(db, sourceTag)).toBe(0);
  });

  test("ignores changes in excluded directories", async () => {
    // Create an excluded subdirectory
    const excludedDir = join(tempDir, "node_modules");
    mkdirSync(excludedDir, { recursive: true });

    watcher = new DocumentWatcher(indexer, logger, {
      debounceMs: 100,
      fileTypes: [".md"],
      exclude: ["node_modules"],
    });
    watcher.startWatching([tempDir]);

    // Write a file in the excluded directory
    writeFileSync(join(excludedDir, "should-ignore.md"), "# Ignored\n\nThis should not be indexed.");

    // Wait a bit -- nothing should be indexed
    await new Promise((r) => setTimeout(r, 500));
    expect(countMemories(db)).toBe(0);
  });

  test("ignores files with non-matching extensions", async () => {
    watcher = new DocumentWatcher(indexer, logger, {
      debounceMs: 100,
      fileTypes: [".md"],
      exclude: [],
    });
    watcher.startWatching([tempDir]);

    // Write a .json file (not in fileTypes)
    writeFileSync(join(tempDir, `ignored-${Date.now()}.json`), '{"ignored": true}');

    // Wait a bit -- nothing should be indexed
    await new Promise((r) => setTimeout(r, 500));
    expect(countMemories(db)).toBe(0);
  });
});
