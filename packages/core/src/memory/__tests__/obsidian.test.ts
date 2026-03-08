import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import { KGEntityStore } from "../knowledge-graph/entities.ts";
import { KGRelationStore } from "../knowledge-graph/relations.ts";
import { ObsidianIndexer, parseObsidianTags, parseWikilinks } from "../obsidian.ts";
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

function createTempVault(): string {
  const vaultPath = join(tmpdir(), `eidolon-test-vault-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(vaultPath, { recursive: true });
  return vaultPath;
}

// ---------------------------------------------------------------------------
// parseWikilinks
// ---------------------------------------------------------------------------

describe("parseWikilinks", () => {
  test("extracts simple wikilinks", () => {
    const content = "See [[Note A]] and [[Note B]] for details.";
    const links = parseWikilinks(content);
    expect(links).toContain("Note A");
    expect(links).toContain("Note B");
    expect(links).toHaveLength(2);
  });

  test("extracts wikilinks with aliases", () => {
    const content = "Check [[Real Note|display text]] here.";
    const links = parseWikilinks(content);
    expect(links).toContain("Real Note");
    expect(links).toHaveLength(1);
  });

  test("extracts wikilinks with heading anchors", () => {
    const content = "See [[Note A#Section 1]] for details.";
    const links = parseWikilinks(content);
    expect(links).toContain("Note A");
    expect(links).toHaveLength(1);
  });

  test("deduplicates wikilinks", () => {
    const content = "See [[Note A]] and [[Note A]] again.";
    const links = parseWikilinks(content);
    expect(links).toEqual(["Note A"]);
  });

  test("returns empty array for content without wikilinks", () => {
    const content = "No links here, just plain text.";
    const links = parseWikilinks(content);
    expect(links).toEqual([]);
  });

  test("handles wikilinks with heading and alias", () => {
    const content = "[[Note A#Heading|Display Text]]";
    const links = parseWikilinks(content);
    expect(links).toContain("Note A");
    expect(links).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// parseObsidianTags
// ---------------------------------------------------------------------------

describe("parseObsidianTags", () => {
  test("extracts simple tags", () => {
    const content = "This has #typescript and #programming tags.";
    const tags = parseObsidianTags(content);
    expect(tags).toContain("typescript");
    expect(tags).toContain("programming");
  });

  test("normalizes tags to lowercase", () => {
    const content = "Mixed case #TypeScript and #RUST tags.";
    const tags = parseObsidianTags(content);
    expect(tags).toContain("typescript");
    expect(tags).toContain("rust");
  });

  test("supports nested tags with slashes", () => {
    const content = "A #dev/typescript/bun nested tag.";
    const tags = parseObsidianTags(content);
    expect(tags).toContain("dev/typescript/bun");
  });

  test("deduplicates tags", () => {
    const content = "#typescript and #typescript again.";
    const tags = parseObsidianTags(content);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toBe("typescript");
  });

  test("returns empty array for content without tags", () => {
    const content = "No tags here.";
    const tags = parseObsidianTags(content);
    expect(tags).toEqual([]);
  });

  test("handles tag at start of line", () => {
    const content = "#beginning-tag is at the start.";
    const tags = parseObsidianTags(content);
    expect(tags).toContain("beginning-tag");
  });
});

// ---------------------------------------------------------------------------
// ObsidianIndexer
// ---------------------------------------------------------------------------

describe("ObsidianIndexer", () => {
  let db: Database;
  let store: MemoryStore;
  let entityStore: KGEntityStore;
  let relationStore: KGRelationStore;
  let indexer: ObsidianIndexer;
  let vaultPath: string;

  beforeEach(() => {
    db = createTestDb();
    const logger = createSilentLogger();
    store = new MemoryStore(db, logger);
    entityStore = new KGEntityStore(db, logger);
    relationStore = new KGRelationStore(db, logger);
    indexer = new ObsidianIndexer(db, store, entityStore, relationStore, logger);
    vaultPath = createTempVault();
  });

  afterEach(() => {
    db.close();
    try {
      rmSync(vaultPath, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  // -- indexNote ------------------------------------------------------------

  test("indexNote stores note content as memory", () => {
    const notePath = join(vaultPath, "test-note.md");
    writeFileSync(notePath, "# Test\nSome content here.");

    const result = indexer.indexNote(notePath, vaultPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chunksStored).toBe(1);

    // Verify memory was stored
    const row = db.query("SELECT * FROM memories WHERE source = ?").get("obsidian:test-note.md") as {
      content: string;
      tags: string;
    } | null;
    expect(row).not.toBeNull();
    expect(row?.content).toContain("Some content here.");
    expect(row?.tags).toContain("obsidian");
  });

  test("indexNote creates KG entities for wikilinks", () => {
    const notePath = join(vaultPath, "my-note.md");
    writeFileSync(notePath, "Links to [[TypeScript]] and [[Bun]].");

    const result = indexer.indexNote(notePath, vaultPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // note entity + 2 link targets
    expect(result.value.entitiesCreated).toBe(3);
    expect(result.value.relationsCreated).toBe(2);

    // Verify entities exist
    const entities = db.query("SELECT name FROM kg_entities ORDER BY name").all() as { name: string }[];
    const names = entities.map((e) => e.name);
    expect(names).toContain("Bun");
    expect(names).toContain("TypeScript");
    expect(names).toContain("my-note");
  });

  test("indexNote extracts tags and includes them in memory", () => {
    const notePath = join(vaultPath, "tagged.md");
    writeFileSync(notePath, "Content with #programming and #typescript tags.");

    const result = indexer.indexNote(notePath, vaultPath);
    expect(result.ok).toBe(true);

    const row = db.query("SELECT tags FROM memories WHERE source = ?").get("obsidian:tagged.md") as {
      tags: string;
    } | null;
    expect(row).not.toBeNull();
    const tags: string[] = JSON.parse(row?.tags ?? "[]");
    expect(tags).toContain("obsidian");
    expect(tags).toContain("programming");
    expect(tags).toContain("typescript");
  });

  test("indexNote re-indexes by deleting old memories first", () => {
    const notePath = join(vaultPath, "reindex.md");
    writeFileSync(notePath, "Version 1 content.");

    const result1 = indexer.indexNote(notePath, vaultPath);
    expect(result1.ok).toBe(true);

    // Verify one memory exists
    const count1 = (
      db.query("SELECT COUNT(*) as count FROM memories WHERE source = ?").get("obsidian:reindex.md") as {
        count: number;
      }
    ).count;
    expect(count1).toBe(1);

    // Re-index with updated content
    writeFileSync(notePath, "Version 2 content.");
    const result2 = indexer.indexNote(notePath, vaultPath);
    expect(result2.ok).toBe(true);

    // Still only one memory (old was deleted)
    const count2 = (
      db.query("SELECT COUNT(*) as count FROM memories WHERE source = ?").get("obsidian:reindex.md") as {
        count: number;
      }
    ).count;
    expect(count2).toBe(1);

    // Content is updated
    const row = db.query("SELECT content FROM memories WHERE source = ?").get("obsidian:reindex.md") as {
      content: string;
    } | null;
    expect(row?.content).toBe("Version 2 content.");
  });

  test("indexNote returns error for file outside vault root", () => {
    const result = indexer.indexNote("/nonexistent/file.md", vaultPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("is outside vault root");
  });

  test("indexNote returns error for missing file inside vault", () => {
    const result = indexer.indexNote(join(vaultPath, "does-not-exist.md"), vaultPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("File not found");
  });

  // -- indexVault -----------------------------------------------------------

  test("indexVault indexes all markdown files recursively", () => {
    writeFileSync(join(vaultPath, "note1.md"), "Note 1 with [[note2]].");
    const subDir = join(vaultPath, "sub");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "note2.md"), "Note 2 with #tag.");

    const result = indexer.indexVault(vaultPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesIndexed).toBe(2);
    expect(result.value.chunksStored).toBe(2);
  });

  test("indexVault skips .obsidian directory", () => {
    writeFileSync(join(vaultPath, "good.md"), "Good note.");
    const obsDir = join(vaultPath, ".obsidian");
    mkdirSync(obsDir, { recursive: true });
    writeFileSync(join(obsDir, "config.md"), "Config file.");

    const result = indexer.indexVault(vaultPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesIndexed).toBe(1);
  });

  test("indexVault returns error for nonexistent path", () => {
    const result = indexer.indexVault("/nonexistent/vault");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Vault not found");
  });

  test("indexVault skips non-markdown files", () => {
    writeFileSync(join(vaultPath, "note.md"), "Markdown note.");
    writeFileSync(join(vaultPath, "image.png"), "not-really-a-png");
    writeFileSync(join(vaultPath, "data.json"), '{"key": "value"}');

    const result = indexer.indexVault(vaultPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.filesIndexed).toBe(1);
  });
});
