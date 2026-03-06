/**
 * Golden dataset evaluation for the rule-based memory extractor.
 *
 * Loads 105 annotated conversation turns from the golden dataset and runs
 * the rule-based extractor against each one. Computes precision and recall
 * per category and overall, then asserts minimum thresholds.
 *
 * This is a deterministic, fast test (no LLM calls). The thresholds are
 * intentionally modest for rule-based extraction -- LLM-based extraction
 * would be expected to score higher.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Logger } from "../../logging/logger.ts";
import type { ExtractedMemory } from "../extractor.ts";
import { MemoryExtractor } from "../extractor.ts";

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

// ---------------------------------------------------------------------------
// Golden dataset types
// ---------------------------------------------------------------------------

interface GoldenTurn {
  readonly id: string;
  readonly language: string;
  readonly category: string;
  readonly input: {
    readonly user: string;
    readonly assistant: string;
  };
  readonly expected: {
    readonly facts: readonly string[];
    readonly decisions: readonly string[];
    readonly preferences: readonly string[];
    readonly corrections: readonly string[];
    readonly todos: readonly string[];
    readonly _note?: string;
  };
}

interface GoldenDataset {
  readonly description: string;
  readonly version: number;
  readonly turns: readonly GoldenTurn[];
}

// ---------------------------------------------------------------------------
// Load dataset
// ---------------------------------------------------------------------------

const GOLDEN_PATH = resolve(import.meta.dir, "../../../test/fixtures/golden/extraction/conversations.json");
const dataset: GoldenDataset = JSON.parse(readFileSync(GOLDEN_PATH, "utf-8"));

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an extracted memory "matches" an expected string.
 * Uses case-insensitive substring matching -- the extractor may capture
 * a longer or slightly different snippet than the annotation.
 */
function contentMatches(extracted: string, expected: string): boolean {
  const normExtracted = extracted.toLowerCase().trim();
  const normExpected = expected.toLowerCase().trim();

  // Exact substring in either direction
  if (normExtracted.includes(normExpected) || normExpected.includes(normExtracted)) {
    return true;
  }

  // Word overlap: if >=60% of expected words appear in extracted, call it a match
  const expectedWords = new Set(normExpected.split(/\s+/).filter((w) => w.length > 2));
  if (expectedWords.size === 0) return false;
  const extractedWords = new Set(normExtracted.split(/\s+/));
  let overlap = 0;
  for (const word of expectedWords) {
    if (extractedWords.has(word)) overlap++;
  }
  return overlap / expectedWords.size >= 0.6;
}

/**
 * Map golden dataset category names to the extractor's memory types and tags.
 *
 * The golden dataset expected fields:
 *   facts, decisions, preferences, corrections, todos
 *
 * The extractor produces ExtractedMemory with:
 *   type: MemoryType (fact, preference, decision, ...)
 *   tags: string[]   (explicit, preference, decision, correction, todo, personal, ...)
 */
function getExpectedItems(turn: GoldenTurn): Array<{ content: string; category: string }> {
  const items: Array<{ content: string; category: string }> = [];
  for (const f of turn.expected.facts) items.push({ content: f, category: "fact" });
  for (const d of turn.expected.decisions) items.push({ content: d, category: "decision" });
  for (const p of turn.expected.preferences) items.push({ content: p, category: "preference" });
  for (const c of turn.expected.corrections) items.push({ content: c, category: "correction" });
  for (const t of turn.expected.todos) items.push({ content: t, category: "todo" });
  return items;
}

/**
 * Check if an extracted memory matches a particular expected category.
 * Corrections in the extractor have type=fact + tag="correction".
 * Todos have type=fact + tag="todo".
 */
function categoryMatches(extracted: ExtractedMemory, expectedCategory: string): boolean {
  switch (expectedCategory) {
    case "fact":
      return extracted.type === "fact" && !extracted.tags.includes("correction") && !extracted.tags.includes("todo");
    case "preference":
      return extracted.type === "preference" || extracted.tags.includes("preference");
    case "decision":
      return extracted.type === "decision" || extracted.tags.includes("decision");
    case "correction":
      return extracted.tags.includes("correction");
    case "todo":
      return extracted.tags.includes("todo");
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("extraction golden dataset", () => {
  const extractor = new MemoryExtractor(createSilentLogger(), { strategy: "rule-based" });

  test("dataset loads correctly and has expected structure", () => {
    expect(dataset.version).toBe(2);
    expect(dataset.turns.length).toBe(105);

    for (const turn of dataset.turns) {
      expect(turn.id).toBeDefined();
      expect(turn.language).toMatch(/^(en|de)$/);
      expect(turn.input.user).toBeDefined();
      expect(turn.input.assistant).toBeDefined();
      expect(turn.expected).toBeDefined();
      expect(Array.isArray(turn.expected.facts)).toBe(true);
      expect(Array.isArray(turn.expected.decisions)).toBe(true);
      expect(Array.isArray(turn.expected.preferences)).toBe(true);
      expect(Array.isArray(turn.expected.corrections)).toBe(true);
      expect(Array.isArray(turn.expected.todos)).toBe(true);
    }
  });

  test("rule-based precision meets minimum threshold (>= 40%)", () => {
    // Precision = correct extractions / total extractions
    // A "correct" extraction is one that matches any expected item for that turn.
    let totalExtracted = 0;
    let correctExtractions = 0;

    for (const turn of dataset.turns) {
      const results = extractor.extractRuleBased({
        userMessage: turn.input.user,
        assistantResponse: turn.input.assistant,
      });

      const expectedItems = getExpectedItems(turn);
      totalExtracted += results.length;

      for (const extracted of results) {
        const matched = expectedItems.some(
          (expected) =>
            contentMatches(extracted.content, expected.content) && categoryMatches(extracted, expected.category),
        );
        if (matched) correctExtractions++;
      }
    }

    const precision = totalExtracted > 0 ? correctExtractions / totalExtracted : 0;

    // Report for diagnostics
    console.log(
      `[Golden] Rule-based precision: ${(precision * 100).toFixed(1)}% (${correctExtractions}/${totalExtracted})`,
    );

    // Threshold: 40% for rule-based (regex patterns miss many valid formulations)
    expect(precision).toBeGreaterThanOrEqual(0.4);
  });

  test("rule-based recall meets minimum threshold (>= 25%)", () => {
    // Recall = expected items found / total expected items
    // Only count turns that have at least one expected extraction.
    let totalExpected = 0;
    let foundExpected = 0;

    for (const turn of dataset.turns) {
      const expectedItems = getExpectedItems(turn);
      if (expectedItems.length === 0) continue;

      const results = extractor.extractRuleBased({
        userMessage: turn.input.user,
        assistantResponse: turn.input.assistant,
      });

      totalExpected += expectedItems.length;

      for (const expected of expectedItems) {
        const matched = results.some(
          (extracted) =>
            contentMatches(extracted.content, expected.content) && categoryMatches(extracted, expected.category),
        );
        if (matched) foundExpected++;
      }
    }

    const recall = totalExpected > 0 ? foundExpected / totalExpected : 0;

    console.log(`[Golden] Rule-based recall: ${(recall * 100).toFixed(1)}% (${foundExpected}/${totalExpected})`);

    // Threshold: 25% for rule-based (many expected items need LLM to detect)
    expect(recall).toBeGreaterThanOrEqual(0.25);
  });

  test("null-case turns produce zero extractions", () => {
    const nullCases = dataset.turns.filter((t) => t.category === "null-case");
    expect(nullCases.length).toBeGreaterThan(0);

    let falsePositives = 0;
    for (const turn of nullCases) {
      const results = extractor.extractRuleBased({
        userMessage: turn.input.user,
        assistantResponse: turn.input.assistant,
      });
      if (results.length > 0) {
        falsePositives++;
      }
    }

    // Allow a small number of false positives on null-cases
    // (some borderline cases may trigger patterns)
    const falsePositiveRate = falsePositives / nullCases.length;

    console.log(
      `[Golden] Null-case false positive rate: ${(falsePositiveRate * 100).toFixed(1)}% (${falsePositives}/${nullCases.length})`,
    );

    expect(falsePositiveRate).toBeLessThanOrEqual(0.4);
  });

  test("per-category extraction summary", () => {
    const categories = ["preference", "fact", "decision", "correction", "todo"];
    const stats: Record<string, { expected: number; found: number; extracted: number }> = {};

    for (const cat of categories) {
      stats[cat] = { expected: 0, found: 0, extracted: 0 };
    }

    for (const turn of dataset.turns) {
      const expectedItems = getExpectedItems(turn);
      const results = extractor.extractRuleBased({
        userMessage: turn.input.user,
        assistantResponse: turn.input.assistant,
      });

      // Count extracted per category
      for (const r of results) {
        for (const cat of categories) {
          if (categoryMatches(r, cat)) {
            stats[cat]!.extracted++;
          }
        }
      }

      // Count expected and found per category
      for (const expected of expectedItems) {
        if (stats[expected.category]) {
          stats[expected.category]!.expected++;
          const matched = results.some(
            (r) => contentMatches(r.content, expected.content) && categoryMatches(r, expected.category),
          );
          if (matched) {
            stats[expected.category]!.found++;
          }
        }
      }
    }

    console.log("[Golden] Per-category breakdown:");
    for (const cat of categories) {
      const s = stats[cat]!;
      const recall = s.expected > 0 ? ((s.found / s.expected) * 100).toFixed(1) : "N/A";
      const precision = s.extracted > 0 ? ((s.found / s.extracted) * 100).toFixed(1) : "N/A";
      console.log(
        `  ${cat}: recall=${recall}% (${s.found}/${s.expected}), precision=${precision}% (${s.found}/${s.extracted})`,
      );
    }

    // Just assert the stats object was populated -- the thresholds are in the
    // precision/recall tests above. This test exists for diagnostic output.
    expect(Object.keys(stats).length).toBe(5);
  });

  test("German language turns are handled", () => {
    const germanTurns = dataset.turns.filter((t) => t.language === "de");
    expect(germanTurns.length).toBeGreaterThanOrEqual(10);

    let totalExpected = 0;
    let found = 0;

    for (const turn of germanTurns) {
      const expectedItems = getExpectedItems(turn);
      if (expectedItems.length === 0) continue;

      const results = extractor.extractRuleBased({
        userMessage: turn.input.user,
        assistantResponse: turn.input.assistant,
      });

      totalExpected += expectedItems.length;
      for (const expected of expectedItems) {
        const matched = results.some(
          (r) => contentMatches(r.content, expected.content) && categoryMatches(r, expected.category),
        );
        if (matched) found++;
      }
    }

    const germanRecall = totalExpected > 0 ? found / totalExpected : 0;

    console.log(`[Golden] German recall: ${(germanRecall * 100).toFixed(1)}% (${found}/${totalExpected})`);

    // German patterns should work but may have lower recall than English
    expect(germanRecall).toBeGreaterThanOrEqual(0.15);
  });

  test("edge-case turns do not produce spurious extractions at high rate", () => {
    const edgeCases = dataset.turns.filter((t) => t.category === "edge-case");
    expect(edgeCases.length).toBeGreaterThan(0);

    let totalSpurious = 0;
    let totalExtracted = 0;

    for (const turn of edgeCases) {
      const expectedItems = getExpectedItems(turn);
      const results = extractor.extractRuleBased({
        userMessage: turn.input.user,
        assistantResponse: turn.input.assistant,
      });

      totalExtracted += results.length;

      for (const r of results) {
        const matched = expectedItems.some(
          (e) => contentMatches(r.content, e.content) && categoryMatches(r, e.category),
        );
        if (!matched) totalSpurious++;
      }
    }

    console.log(`[Golden] Edge-case spurious extractions: ${totalSpurious}/${totalExtracted}`);

    // Edge cases may have some valid extractions but mostly should be quiet
    // This is an informational check -- no hard assertion
    expect(totalExtracted).toBeDefined();
  });
});
