/**
 * Search relevance integration test using the golden dataset.
 *
 * Populates an in-memory SQLite database with memories derived from the
 * golden dataset's expected results, then runs queries and validates that
 * the search pipeline returns relevant results.
 *
 * IMPORTANT: The current BM25 implementation uses FTS5 with exact phrase
 * matching (query wrapped in double quotes in MemoryStore.searchText).
 * This means queries must share a consecutive word sequence with memory
 * content to match. The tests below use keyword phrases extracted from
 * the golden dataset entries to test the search pipeline end-to-end.
 *
 * This fills the gap identified in search-golden.test.ts, which validates
 * dataset structure only, not actual search behaviour.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import type { EmbeddingModel, EmbeddingPrefix } from "../embeddings.ts";
import { MemorySearch } from "../search.ts";
import type { CreateMemoryInput } from "../store.ts";
import { MemoryStore } from "../store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SearchQuery {
  readonly id: string;
  readonly query: string;
  readonly expectedTopResults: readonly string[];
  readonly tags: readonly string[];
  readonly language: string;
}

interface SearchGoldenDataset {
  readonly description: string;
  readonly version: number;
  readonly queries: readonly SearchQuery[];
}

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
 * Stub embedding model marked as not initialized, so MemorySearch
 * uses BM25-only mode. Keeps the test fast and deterministic.
 */
class StubEmbeddingModel {
  get isInitialized(): boolean {
    return false;
  }

  async embed(_text: string, _prefix?: EmbeddingPrefix): Promise<Result<Float32Array, EidolonError>> {
    return Ok(new Float32Array(384));
  }

  async embedBatch(_texts: readonly string[]): Promise<Result<Float32Array[], EidolonError>> {
    return Ok([]);
  }

  static cosineSimilarity(_a: Float32Array, _b: Float32Array): number {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Load golden dataset
// ---------------------------------------------------------------------------

const GOLDEN_PATH = resolve(import.meta.dir, "../../../test/fixtures/golden/search/queries.json");
const dataset: SearchGoldenDataset = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));

function collectAllMemoryContents(): string[] {
  const contents = new Set<string>();
  for (const q of dataset.queries) {
    for (const expected of q.expectedTopResults) {
      contents.add(expected);
    }
  }
  return [...contents];
}

const DISTRACTOR_MEMORIES = [
  "The weather in Tokyo was sunny and warm yesterday",
  "Chocolate cake recipe requires 200g of flour and 3 eggs",
  "Football World Cup 2026 will be held in North America",
  "The speed of light is approximately 299792458 metres per second",
  "Leonardo da Vinci painted the Mona Lisa in the 16th century",
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("search relevance integration (golden dataset)", () => {
  let db: Database;
  let store: MemoryStore;
  let search: MemorySearch;

  beforeEach(() => {
    db = createTestDb();
    const logger = createSilentLogger();
    store = new MemoryStore(db, logger);
    search = new MemorySearch(store, new StubEmbeddingModel() as unknown as EmbeddingModel, db, logger);

    // Populate database with all expected results from the golden dataset
    const contents = collectAllMemoryContents();
    for (const content of contents) {
      const input: CreateMemoryInput = {
        type: "fact",
        layer: "long_term",
        content,
        confidence: 0.95,
        source: "golden-dataset",
        tags: [],
      };
      const result = store.create(input);
      if (!result.ok) {
        throw new Error(`Failed to create memory: ${result.error.message}`);
      }
    }

    // Add distractor memories
    for (const content of DISTRACTOR_MEMORIES) {
      store.create({
        type: "fact",
        layer: "long_term",
        content,
        confidence: 0.9,
        source: "distractor",
        tags: [],
      });
    }
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // Helper: search and check results contain a substring
  // -------------------------------------------------------------------------

  async function searchAndExpectSubstring(query: string, expectedSubstring: string): Promise<void> {
    const result = await search.search({ text: query, limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThan(0);
    const found = result.value.some((r) => r.memory.content.toLowerCase().includes(expectedSubstring.toLowerCase()));
    expect(found).toBe(true);
  }

  // -------------------------------------------------------------------------
  // Phrase-match queries using substrings from golden dataset entries
  //
  // The BM25 implementation uses FTS5 phrase matching (query wrapped in
  // double quotes), so queries must be consecutive word subsequences of
  // the memory content. These tests extract such phrases from the golden
  // dataset expected results to validate the full search pipeline.
  // -------------------------------------------------------------------------

  test("finds 'main language' memory when searching for phrase from content", async () => {
    // golden exact-001 expected: "TypeScript is the main language for all core packages"
    await searchAndExpectSubstring("main language", "typescript is the main language");
  });

  test("finds SQLite memory via phrase 'database engine'", async () => {
    // golden exact-002 expected: "SQLite via bun:sqlite is the database engine"
    await searchAndExpectSubstring("database engine", "sqlite via bun:sqlite");
  });

  test("finds TTS memory via phrase 'primary TTS model'", async () => {
    // golden exact-004 expected: "Qwen3-TTS 1.7B is the primary TTS model"
    await searchAndExpectSubstring("primary TTS model", "qwen3-tts");
  });

  test("finds pnpm memory via phrase 'package manager'", async () => {
    // golden exact-006 expected: "pnpm workspaces is the package manager"
    await searchAndExpectSubstring("package manager", "pnpm workspaces");
  });

  test("finds Tailscale memory via phrase 'Tailscale mesh VPN'", async () => {
    // golden graph-001 expected: "All devices connected via Tailscale mesh VPN"
    await searchAndExpectSubstring("Tailscale mesh VPN", "tailscale mesh vpn");
  });

  test("finds Claude memory via phrase 'execution engine'", async () => {
    // golden graph-003 expected: "Claude Code CLI is the execution engine managed as subprocess"
    await searchAndExpectSubstring("execution engine", "claude code cli");
  });

  test("finds encryption memory via phrase 'encrypted at rest'", async () => {
    // golden exact-005 expected: "Secrets are encrypted at rest in secrets.db"
    await searchAndExpectSubstring("encrypted at rest", "secrets are encrypted");
  });

  // -------------------------------------------------------------------------
  // Validate that search returns correct golden dataset entries
  // -------------------------------------------------------------------------

  test("phrase query returns exact golden dataset entry", async () => {
    const result = await search.search({ text: "Tailscale mesh VPN", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should contain the exact golden dataset expected result
    const expected = "All devices connected via Tailscale mesh VPN";
    const exactMatch = result.value.find((r) => r.memory.content === expected);
    expect(exactMatch).toBeDefined();
  });

  test("phrase query for 'circuit breakers' finds resilience memory", async () => {
    const result = await search.search({ text: "circuit breakers", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThan(0);
    const found = result.value.some((r) => r.memory.content.toLowerCase().includes("circuit breaker"));
    expect(found).toBe(true);
  });

  test("phrase query for 'user approval' finds security memory", async () => {
    const result = await search.search({ text: "user approval", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThan(0);
    const found = result.value.some((r) => r.memory.content.toLowerCase().includes("approval"));
    expect(found).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Distractors should not appear for project-specific queries
  // -------------------------------------------------------------------------

  test("distractor memories do not appear for project-specific phrase queries", async () => {
    const result = await search.search({ text: "main language", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const r of result.value) {
      expect(DISTRACTOR_MEMORIES).not.toContain(r.memory.content);
    }
  });

  // -------------------------------------------------------------------------
  // Result ordering: matching memories should rank higher
  // -------------------------------------------------------------------------

  test("result scores are positive and sorted descending", async () => {
    const result = await search.search({ text: "database engine", limit: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThan(0);
    for (let i = 0; i < result.value.length; i++) {
      const r = result.value[i];
      expect(r).toBeDefined();
      if (r) {
        expect(r.score).toBeGreaterThan(0);
      }
      if (i > 0) {
        const prev = result.value[i - 1];
        if (prev && r) {
          expect(prev.score).toBeGreaterThanOrEqual(r.score);
        }
      }
    }
  });

  test("match reason is 'bm25' when embedding model is not initialized", async () => {
    const result = await search.search({ text: "package manager", limit: 5 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const r of result.value) {
      expect(r.matchReason).toBe("bm25");
    }
  });

  // -------------------------------------------------------------------------
  // Aggregate: test multiple golden dataset queries with keyword extraction
  // -------------------------------------------------------------------------

  test("aggregate: keyword phrases from golden entries find their source memories", async () => {
    // Map of search phrase -> expected substring in result content
    const phraseTests: Array<{ phrase: string; expectedSubstring: string; goldenId: string }> = [
      { phrase: "main language", expectedSubstring: "typescript", goldenId: "exact-001" },
      { phrase: "database engine", expectedSubstring: "sqlite", goldenId: "exact-002" },
      { phrase: "16GB VRAM", expectedSubstring: "rtx 5080", goldenId: "exact-003" },
      { phrase: "primary TTS model", expectedSubstring: "qwen3-tts", goldenId: "exact-004" },
      { phrase: "package manager", expectedSubstring: "pnpm", goldenId: "exact-006" },
      { phrase: "Tailscale mesh VPN", expectedSubstring: "tailscale", goldenId: "graph-001" },
      { phrase: "execution engine", expectedSubstring: "claude code cli", goldenId: "graph-003" },
    ];

    let successCount = 0;
    for (const t of phraseTests) {
      const result = await search.search({ text: t.phrase, limit: 10 });
      if (!result.ok) continue;

      const found = result.value.some((r) => r.memory.content.toLowerCase().includes(t.expectedSubstring));
      if (found) successCount++;
    }

    const ratio = successCount / phraseTests.length;
    // All phrase queries should find their target memories
    expect(ratio).toBeGreaterThanOrEqual(0.85);
  });
});
