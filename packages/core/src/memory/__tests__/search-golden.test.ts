/**
 * Golden dataset validation for memory search relevance queries.
 *
 * This test file validates the structure and completeness of the search
 * relevance golden dataset. Actual search relevance testing would require
 * a populated database with memories and embeddings -- that is deferred
 * to integration tests.
 *
 * The dataset covers 6 categories:
 * - exact-match: queries with keywords that should match directly
 * - semantic: queries that require understanding, not just keyword matching
 * - german: German-language queries
 * - graph-connected: queries where related entities should surface via graph walk
 * - multi-topic: queries spanning multiple knowledge areas
 * - negation: queries about what the project does NOT use
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
// Load dataset
// ---------------------------------------------------------------------------

const GOLDEN_PATH = resolve(import.meta.dir, "../../../test/fixtures/golden/search/queries.json");
const dataset: SearchGoldenDataset = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("search relevance golden dataset", () => {
  test("dataset loads and has valid structure", () => {
    expect(dataset.version).toBe(1);
    expect(dataset.description).toBeDefined();
    expect(Array.isArray(dataset.queries)).toBe(true);
  });

  test("contains at least 30 queries", () => {
    expect(dataset.queries.length).toBeGreaterThanOrEqual(30);
  });

  test("every query has required fields", () => {
    for (const q of dataset.queries) {
      expect(typeof q.id).toBe("string");
      expect(q.id.length).toBeGreaterThan(0);

      expect(typeof q.query).toBe("string");
      expect(q.query.length).toBeGreaterThan(0);

      expect(Array.isArray(q.expectedTopResults)).toBe(true);
      expect(q.expectedTopResults.length).toBeGreaterThanOrEqual(1);
      for (const result of q.expectedTopResults) {
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }

      expect(Array.isArray(q.tags)).toBe(true);
      expect(q.tags.length).toBeGreaterThanOrEqual(1);

      expect(typeof q.language).toBe("string");
      expect(q.language).toMatch(/^(en|de)$/);
    }
  });

  test("all query IDs are unique", () => {
    const ids = dataset.queries.map((q) => q.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test("contains at least 5 exact-match queries", () => {
    const exactMatch = dataset.queries.filter((q) => q.tags.includes("exact-match"));
    expect(exactMatch.length).toBeGreaterThanOrEqual(5);
  });

  test("contains at least 5 semantic similarity queries", () => {
    const semantic = dataset.queries.filter((q) => q.tags.includes("semantic"));
    expect(semantic.length).toBeGreaterThanOrEqual(5);
  });

  test("contains at least 5 German language queries", () => {
    const german = dataset.queries.filter((q) => q.tags.includes("german"));
    expect(german.length).toBeGreaterThanOrEqual(5);

    // All German-tagged queries should have language=de
    for (const q of german) {
      expect(q.language).toBe("de");
    }
  });

  test("contains at least 5 graph-connected queries", () => {
    const graph = dataset.queries.filter((q) => q.tags.includes("graph-connected"));
    expect(graph.length).toBeGreaterThanOrEqual(5);
  });

  test("contains at least 5 multi-topic queries", () => {
    const multi = dataset.queries.filter((q) => q.tags.includes("multi-topic"));
    expect(multi.length).toBeGreaterThanOrEqual(5);
  });

  test("contains at least 5 negation/absence queries", () => {
    const negation = dataset.queries.filter((q) => q.tags.includes("negation"));
    expect(negation.length).toBeGreaterThanOrEqual(5);
  });

  test("category distribution summary", () => {
    const tagCounts: Record<string, number> = {};
    for (const q of dataset.queries) {
      for (const tag of q.tags) {
        tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
      }
    }

    const languageCounts: Record<string, number> = {};
    for (const q of dataset.queries) {
      languageCounts[q.language] = (languageCounts[q.language] ?? 0) + 1;
    }

    console.log(`[Search Golden] Total queries: ${dataset.queries.length}`);
    console.log("[Search Golden] Tags:", JSON.stringify(tagCounts));
    console.log("[Search Golden] Languages:", JSON.stringify(languageCounts));

    // Ensure all expected tags are present
    expect(tagCounts["exact-match"]).toBeGreaterThanOrEqual(5);
    expect(tagCounts.semantic).toBeGreaterThanOrEqual(5);
    expect(tagCounts.german).toBeGreaterThanOrEqual(5);
    expect(tagCounts["graph-connected"]).toBeGreaterThanOrEqual(5);
    expect(tagCounts["multi-topic"]).toBeGreaterThanOrEqual(5);
    expect(tagCounts.negation).toBeGreaterThanOrEqual(5);
  });

  test("expected results are descriptive (min 10 chars each)", () => {
    for (const q of dataset.queries) {
      for (const result of q.expectedTopResults) {
        expect(result.length).toBeGreaterThanOrEqual(10);
      }
    }
  });

  test("queries cover key project concepts", () => {
    const allQueries = dataset.queries.map((q) => q.query.toLowerCase()).join(" ");
    const allExpected = dataset.queries
      .flatMap((q) => q.expectedTopResults)
      .map((r) => r.toLowerCase())
      .join(" ");
    const combined = `${allQueries} ${allExpected}`;

    // Key concepts that should appear somewhere in the dataset
    const keyConcepts = [
      "typescript",
      "sqlite",
      "tailscale",
      "claude",
      "memory",
      "tts",
      "telegram",
      "encryption",
      "gpu",
      "bun",
    ];

    for (const concept of keyConcepts) {
      expect(combined).toContain(concept);
    }
  });
});
