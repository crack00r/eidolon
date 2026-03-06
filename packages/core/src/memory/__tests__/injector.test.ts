import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import type { EmbeddingModel, EmbeddingPrefix } from "../embeddings.ts";
import { MemoryInjector } from "../injector.ts";
import { CommunityDetector } from "../knowledge-graph/communities.ts";
import { KGEntityStore } from "../knowledge-graph/entities.ts";
import { KGRelationStore } from "../knowledge-graph/relations.ts";
import { MemorySearch } from "../search.ts";
import type { CreateMemoryInput } from "../store.ts";
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

/**
 * Mock embedding model that always returns an error.
 * This forces search to fall back to BM25-only, which works fine with FTS5.
 */
const mockEmbeddingModel = {
  isInitialized: false,
  async embed(_text: string, _prefix?: EmbeddingPrefix): Promise<Result<Float32Array, EidolonError>> {
    return Err(createError(ErrorCode.EMBEDDING_FAILED, "mock"));
  },
  async embedBatch(_texts: readonly string[]): Promise<Result<Float32Array[], EidolonError>> {
    return Err(createError(ErrorCode.EMBEDDING_FAILED, "mock"));
  },
} as unknown as EmbeddingModel;

function makeInput(overrides?: Partial<CreateMemoryInput>): CreateMemoryInput {
  return {
    type: "fact",
    layer: "long_term",
    content: "TypeScript is a typed superset of JavaScript",
    confidence: 0.95,
    source: "user",
    tags: ["typescript"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryInjector", () => {
  let db: Database;
  let store: MemoryStore;
  let search: MemorySearch;
  let entityStore: KGEntityStore;
  let relationStore: KGRelationStore;
  let logger: Logger;
  let tmpDir: string;

  beforeEach(() => {
    db = createTestDb();
    logger = createSilentLogger();
    store = new MemoryStore(db, logger);
    search = new MemorySearch(store, mockEmbeddingModel, db, logger);
    entityStore = new KGEntityStore(db, logger);
    relationStore = new KGRelationStore(db, logger);
    tmpDir = mkdtempSync(join(tmpdir(), "eidolon-injector-test-"));
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Minimal content when no memories exist
  // -----------------------------------------------------------------------

  test("generateMemoryMd returns minimal content when no memories exist", async () => {
    const injector = new MemoryInjector(store, search, null, null, logger);

    const result = await injector.generateMemoryMd({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain("# Memory Context");
    expect(result.value).toContain("No relevant memories found for this context.");
  });

  // -----------------------------------------------------------------------
  // 2. Includes static context
  // -----------------------------------------------------------------------

  test("generateMemoryMd includes static context", async () => {
    const injector = new MemoryInjector(store, search, null, null, logger);

    const staticContext = `## User
- Name: Manuel
- Timezone: Europe/Berlin`;

    const result = await injector.generateMemoryMd({ staticContext });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain("# Memory Context");
    // staticContext goes through sanitizeForMarkdown: # → \#, - → \-, newlines → spaces
    expect(result.value).toContain("\\#\\# User");
    expect(result.value).toContain("\\- Name: Manuel");
    expect(result.value).toContain("\\- Timezone: Europe/Berlin");
    // Should NOT contain the "no memories" message when static context is present
    expect(result.value).not.toContain("No relevant memories found");
  });

  // -----------------------------------------------------------------------
  // 3. Groups memories by type
  // -----------------------------------------------------------------------

  test("generateMemoryMd groups memories by type", async () => {
    // Create memories of different types (all long_term + high confidence so they appear in recent)
    store.create(makeInput({ type: "fact", content: "Bun is a JavaScript runtime", confidence: 0.9 }));
    store.create(makeInput({ type: "preference", content: "Prefers TypeScript over JavaScript", confidence: 0.9 }));
    store.create(makeInput({ type: "decision", content: "Chose SQLite for storage", confidence: 0.9 }));
    store.create(makeInput({ type: "fact", content: "Manuel speaks German", confidence: 0.9 }));

    const injector = new MemoryInjector(store, search, null, null, logger);
    const result = await injector.generateMemoryMd({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have grouped sections
    expect(result.value).toContain("## Key Memories");
    expect(result.value).toContain("### Facts");
    expect(result.value).toContain("### Preferences");
    expect(result.value).toContain("### Decisions");
    expect(result.value).toContain("- Bun is a JavaScript runtime");
    expect(result.value).toContain("- Prefers TypeScript over JavaScript");
    expect(result.value).toContain("- Chose SQLite for storage");
    expect(result.value).toContain("- Manuel speaks German");

    // Facts section should come before Preferences (by TYPE_ORDER)
    const factsIdx = result.value.indexOf("### Facts");
    const prefsIdx = result.value.indexOf("### Preferences");
    const decsIdx = result.value.indexOf("### Decisions");
    expect(factsIdx).toBeLessThan(prefsIdx);
    expect(prefsIdx).toBeLessThan(decsIdx);
  });

  // -----------------------------------------------------------------------
  // 4. Includes KG triples when available
  // -----------------------------------------------------------------------

  test("generateMemoryMd includes KG triples when available", async () => {
    // Create entities
    const tsResult = entityStore.create({ name: "TypeScript", type: "technology" });
    const manuelResult = entityStore.create({ name: "Manuel", type: "person" });
    expect(tsResult.ok && manuelResult.ok).toBe(true);
    if (!tsResult.ok || !manuelResult.ok) return;

    // Create relation
    relationStore.create({
      sourceId: manuelResult.value.id,
      targetId: tsResult.value.id,
      type: "uses",
      confidence: 0.95,
      source: "user",
    });

    const injector = new MemoryInjector(store, search, entityStore, relationStore, logger);
    const result = await injector.generateMemoryMd({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain("## Knowledge Graph Context");
    expect(result.value).toContain("- Manuel uses TypeScript (confidence: 0.95)");
  });

  // -----------------------------------------------------------------------
  // 5. Works without KG stores (null)
  // -----------------------------------------------------------------------

  test("generateMemoryMd works without KG stores (null)", async () => {
    store.create(makeInput({ content: "A test fact", confidence: 0.9 }));

    const injector = new MemoryInjector(store, search, null, null, logger);
    const result = await injector.generateMemoryMd({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain("# Memory Context");
    expect(result.value).toContain("- A test fact");
    expect(result.value).not.toContain("## Knowledge Graph Context");
  });

  // -----------------------------------------------------------------------
  // 6. Searches by query when provided
  // -----------------------------------------------------------------------

  test("generateMemoryMd searches by query when provided", async () => {
    // Create memories with different content -- one matches "JavaScript", others don't
    store.create(makeInput({ content: "JavaScript is dynamic", confidence: 0.5, layer: "short_term" }));
    store.create(makeInput({ content: "Rust is a systems language", confidence: 0.5, layer: "short_term" }));

    const injector = new MemoryInjector(store, search, null, null, logger);
    const result = await injector.generateMemoryMd({ query: "JavaScript" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should include the JavaScript memory found via search
    expect(result.value).toContain("- JavaScript is dynamic");
  });

  // -----------------------------------------------------------------------
  // 7. injectIntoWorkspace writes MEMORY.md file
  // -----------------------------------------------------------------------

  test("injectIntoWorkspace writes MEMORY.md file", async () => {
    store.create(makeInput({ content: "Test memory for file write", confidence: 0.9 }));

    const injector = new MemoryInjector(store, search, null, null, logger);
    const result = await injector.injectIntoWorkspace(tmpDir, {});
    expect(result.ok).toBe(true);

    const filePath = join(tmpDir, "MEMORY.md");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# Memory Context");
    expect(content).toContain("- Test memory for file write");
  });

  // -----------------------------------------------------------------------
  // 8. Limits results to maxMemories
  // -----------------------------------------------------------------------

  test("generateMemoryMd limits results to maxMemories", async () => {
    // Create 15 long-term high-confidence memories
    for (let i = 0; i < 15; i++) {
      store.create(makeInput({ content: `Memory item ${i}`, confidence: 0.9 }));
    }

    const injector = new MemoryInjector(store, search, null, null, logger, {
      maxMemories: 5,
    });

    const result = await injector.generateMemoryMd({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Count the number of "- Memory item" lines
    const lines = result.value.split("\n").filter((l) => l.startsWith("- Memory item"));
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  // -----------------------------------------------------------------------
  // 9. Query-aware KG: returns triples for matching entities
  // -----------------------------------------------------------------------

  test("generateMemoryMd returns query-relevant KG triples", async () => {
    // Create entities
    const tsResult = entityStore.create({ name: "TypeScript", type: "technology" });
    const bunResult = entityStore.create({ name: "Bun", type: "technology" });
    const rustResult = entityStore.create({ name: "Rust", type: "technology" });
    expect(tsResult.ok && bunResult.ok && rustResult.ok).toBe(true);
    if (!tsResult.ok || !bunResult.ok || !rustResult.ok) return;

    // Create relations: TypeScript -> Bun, Rust -> unrelated
    relationStore.create({
      sourceId: bunResult.value.id,
      targetId: tsResult.value.id,
      type: "uses",
      confidence: 0.9,
      source: "test",
    });
    relationStore.create({
      sourceId: rustResult.value.id,
      targetId: bunResult.value.id,
      type: "related_to",
      confidence: 0.8,
      source: "test",
    });

    const injector = new MemoryInjector(store, search, entityStore, relationStore, logger);

    // Query for "TypeScript" -- should get the TypeScript-related triple
    const result = await injector.generateMemoryMd({ query: "TypeScript" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain("## Knowledge Graph Context");
    expect(result.value).toContain("Bun uses TypeScript");
  });

  // -----------------------------------------------------------------------
  // 10. Includes community summaries when available
  // -----------------------------------------------------------------------

  test("generateMemoryMd includes community summaries", async () => {
    // Create entities that form a community
    const tsResult = entityStore.create({ name: "TypeScript", type: "technology" });
    const bunResult = entityStore.create({ name: "Bun", type: "technology" });
    expect(tsResult.ok && bunResult.ok).toBe(true);
    if (!tsResult.ok || !bunResult.ok) return;

    // Create bidirectional relations so community detection finds them
    relationStore.create({
      sourceId: tsResult.value.id,
      targetId: bunResult.value.id,
      type: "related_to",
      confidence: 0.9,
      source: "test",
    });
    relationStore.create({
      sourceId: bunResult.value.id,
      targetId: tsResult.value.id,
      type: "depends_on",
      confidence: 0.85,
      source: "test",
    });

    // Detect communities
    const detector = new CommunityDetector(db, logger);
    const detectResult = detector.detectCommunities();
    expect(detectResult.ok).toBe(true);

    const injector = new MemoryInjector(store, search, entityStore, relationStore, logger, undefined, detector);

    // Query for "TypeScript" to trigger entity-aware path
    const result = await injector.generateMemoryMd({ query: "TypeScript" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toContain("## Knowledge Graph Context");
    expect(result.value).toContain("### Related Clusters");
    expect(result.value).toContain("Community:");
  });

  // -----------------------------------------------------------------------
  // 11. Falls back to global triples when no entity matches query
  // -----------------------------------------------------------------------

  test("generateMemoryMd falls back to global triples for unmatched query", async () => {
    // Create entities and a relation
    const aResult = entityStore.create({ name: "SQLite", type: "technology" });
    const bResult = entityStore.create({ name: "WAL", type: "concept" });
    expect(aResult.ok && bResult.ok).toBe(true);
    if (!aResult.ok || !bResult.ok) return;

    relationStore.create({
      sourceId: aResult.value.id,
      targetId: bResult.value.id,
      type: "uses",
      confidence: 0.95,
      source: "test",
    });

    const injector = new MemoryInjector(store, search, entityStore, relationStore, logger);

    // Query that doesn't match any entity name
    const result = await injector.generateMemoryMd({ query: "xyznonexistent" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should still show the global triples as fallback
    expect(result.value).toContain("## Knowledge Graph Context");
    expect(result.value).toContain("SQLite uses WAL");
  });
});
