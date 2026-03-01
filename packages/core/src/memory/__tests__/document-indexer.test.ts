import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../database/migrations.js";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.js";
import type { Logger } from "../../logging/logger.js";
import { DocumentIndexer } from "../document-indexer.js";
import { MemoryStore } from "../store.js";

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

// ---------------------------------------------------------------------------
// Temp file setup
// ---------------------------------------------------------------------------

let tempDir: string;

beforeAll(() => {
  tempDir = join(tmpdir(), `eidolon-doc-indexer-test-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });

  // Markdown file with headings
  writeFileSync(
    join(tempDir, "readme.md"),
    `# Introduction

This is the introduction paragraph.

## Installation

Run the following command:

\`\`\`bash
npm install
\`\`\`

## Usage

Import the module and use it.
`,
  );

  // Plain text file
  writeFileSync(
    join(tempDir, "notes.txt"),
    `First paragraph of notes.

Second paragraph of notes.

Third paragraph of notes.`,
  );

  // TypeScript code file
  writeFileSync(
    join(tempDir, "example.ts"),
    `import { foo } from "bar";

function hello(): void {
  console.log("hello");
}

function world(): string {
  return "world";
}`,
  );

  // Large file (for size limit test)
  writeFileSync(join(tempDir, "large.txt"), "x".repeat(2_000_000));

  // Subdirectory with files
  const subDir = join(tempDir, "sub");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, "nested.md"), "# Nested\n\nNested content.");

  // Excluded directory
  const nodeModules = join(tempDir, "node_modules");
  mkdirSync(nodeModules, { recursive: true });
  writeFileSync(join(nodeModules, "excluded.ts"), "// should be excluded");
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DocumentIndexer", () => {
  let db: Database;
  let store: MemoryStore;
  let indexer: DocumentIndexer;

  beforeEach(() => {
    db = createTestDb();
    store = new MemoryStore(db, createSilentLogger());
    indexer = new DocumentIndexer(db, store, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  // -- Static chunking: Markdown --------------------------------------------

  describe("chunkMarkdown", () => {
    test("splits by headings", () => {
      const content = `# Title

Intro text.

## Section A

Content A.

## Section B

Content B.`;

      const chunks = DocumentIndexer.chunkMarkdown(content, "doc.md");
      expect(chunks.length).toBe(3);
      expect(chunks[0]?.heading).toBe("Title");
      expect(chunks[0]?.content).toContain("Intro text.");
      expect(chunks[1]?.heading).toBe("Section A");
      expect(chunks[1]?.content).toContain("Content A.");
      expect(chunks[2]?.heading).toBe("Section B");
      expect(chunks[2]?.content).toContain("Content B.");
    });

    test("handles heading-less content", () => {
      const content = "Just plain content without any headings.\n\nSecond paragraph.";
      const chunks = DocumentIndexer.chunkMarkdown(content, "doc.md");
      expect(chunks.length).toBe(1);
      expect(chunks[0]?.heading).toBeUndefined();
      expect(chunks[0]?.content).toContain("Just plain content");
    });

    test("respects maxLength by splitting at paragraph boundaries", () => {
      const content = `# Big Section

Paragraph one is here with some text.

Paragraph two is here with some text.

Paragraph three is here with some text.`;

      // Set a low maxLength so the section exceeds it
      const chunks = DocumentIndexer.chunkMarkdown(content, "doc.md", 80);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.heading).toBe("Big Section");
      }
    });
  });

  // -- Static chunking: Plain text ------------------------------------------

  describe("chunkPlainText", () => {
    test("splits by paragraphs", () => {
      const content = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
      const chunks = DocumentIndexer.chunkPlainText(content, "doc.txt", 20);
      // Each paragraph is short, but below limit they get merged.
      // "Paragraph one." = 14 chars; with \n\n + "Paragraph two." = 30 > 20 → split
      expect(chunks.length).toBe(3);
    });

    test("merges small paragraphs up to maxLength", () => {
      const content = "Hi.\n\nBye.";
      // "Hi.\n\nBye." = 9 chars, well under default limit
      const chunks = DocumentIndexer.chunkPlainText(content, "doc.txt");
      expect(chunks.length).toBe(1);
      expect(chunks[0]?.content).toBe("Hi.\n\nBye.");
    });
  });

  // -- Static chunking: Code ------------------------------------------------

  describe("chunkCode", () => {
    test("splits by double newlines", () => {
      const content = `import { a } from "b";

function foo() {
  return 1;
}

function bar() {
  return 2;
}`;

      const chunks = DocumentIndexer.chunkCode(content, "file.ts", 50);
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -- Static chunking: dispatcher ------------------------------------------

  describe("chunkText", () => {
    test("dispatches by file extension", () => {
      const mdContent = "# Title\n\nBody.";
      const tsContent = "const x = 1;\n\nconst y = 2;";
      const txtContent = "Hello.\n\nWorld.";

      const mdChunks = DocumentIndexer.chunkText(mdContent, "file.md");
      const tsChunks = DocumentIndexer.chunkText(tsContent, "file.ts");
      const txtChunks = DocumentIndexer.chunkText(txtContent, "file.txt");

      // Markdown should have heading info
      expect(mdChunks[0]?.heading).toBe("Title");
      // All should produce chunks
      expect(mdChunks.length).toBeGreaterThan(0);
      expect(tsChunks.length).toBeGreaterThan(0);
      expect(txtChunks.length).toBeGreaterThan(0);
    });
  });

  // -- indexFile -------------------------------------------------------------

  describe("indexFile", () => {
    test("stores chunks as memories", () => {
      const result = indexer.indexFile(join(tempDir, "readme.md"));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeGreaterThan(0);

      // Verify memories are in the database
      const countRow = db
        .query("SELECT COUNT(*) as count FROM memories WHERE source = ?")
        .get(`document:${join(tempDir, "readme.md")}`) as { count: number };
      expect(countRow.count).toBe(result.value);
    });

    test("rejects files over size limit", () => {
      // large.txt is 2MB, which exceeds the default 1MB limit
      const result = indexer.indexFile(join(tempDir, "large.txt"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("exceeds max size");
    });

    test("returns error for non-existent file", () => {
      const result = indexer.indexFile(join(tempDir, "nonexistent.md"));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("not found");
    });
  });

  // -- removeDocument -------------------------------------------------------

  describe("removeDocument", () => {
    test("deletes all chunks for a file", () => {
      const filePath = join(tempDir, "readme.md");
      const indexResult = indexer.indexFile(filePath);
      expect(indexResult.ok).toBe(true);
      if (!indexResult.ok) return;
      expect(indexResult.value).toBeGreaterThan(0);

      const removeResult = indexer.removeDocument(filePath);
      expect(removeResult.ok).toBe(true);
      if (!removeResult.ok) return;
      expect(removeResult.value).toBe(indexResult.value);

      // Verify no memories remain for this source
      const countRow = db
        .query("SELECT COUNT(*) as count FROM memories WHERE source = ?")
        .get(`document:${filePath}`) as { count: number };
      expect(countRow.count).toBe(0);
    });
  });

  // -- isIndexed ------------------------------------------------------------

  describe("isIndexed", () => {
    test("returns correct status", () => {
      const filePath = join(tempDir, "notes.txt");

      // Not indexed yet
      const before = indexer.isIndexed(filePath);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      expect(before.value).toBe(false);

      // Index the file
      const indexResult = indexer.indexFile(filePath);
      expect(indexResult.ok).toBe(true);

      // Now indexed
      const after = indexer.isIndexed(filePath);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value).toBe(true);
    });
  });

  // -- indexDirectory -------------------------------------------------------

  describe("indexDirectory", () => {
    test("processes multiple files recursively", () => {
      const result = indexer.indexDirectory(tempDir);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Should have indexed: readme.md, notes.txt, example.ts, sub/nested.md
      // Should NOT have indexed: large.txt (over 1MB), node_modules/excluded.ts
      expect(result.value.files).toBe(4);
      expect(result.value.chunks).toBeGreaterThan(0);
    });

    test("returns error for non-existent directory", () => {
      const result = indexer.indexDirectory(join(tempDir, "nonexistent"));
      expect(result.ok).toBe(false);
    });
  });
});
