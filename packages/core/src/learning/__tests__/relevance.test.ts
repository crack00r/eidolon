import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.js";
import { DeduplicationChecker } from "../deduplication.js";
import { RelevanceFilter } from "../relevance.js";

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

describe("RelevanceFilter", () => {
  const logger = createSilentLogger();

  test("scoreKeywords matches user interests", () => {
    const filter = new RelevanceFilter(
      {
        minScore: 0.6,
        userInterests: ["TypeScript", "AI", "Bun runtime"],
      },
      logger,
    );

    const result = filter.scoreKeywords(
      "TypeScript and AI",
      "This article covers TypeScript patterns for AI development using the Bun runtime.",
    );

    expect(result.score).toBeGreaterThan(0);
    expect(result.matchedInterests.length).toBeGreaterThan(0);
    expect(result.matchedInterests).toContain("TypeScript");
    expect(result.matchedInterests).toContain("AI");
    expect(result.matchedInterests).toContain("Bun runtime");
  });

  test("scoreKeywords returns 0 for no matches", () => {
    const filter = new RelevanceFilter(
      {
        minScore: 0.6,
        userInterests: ["quantum computing", "blockchain"],
      },
      logger,
    );

    const result = filter.scoreKeywords("Cooking Tips", "How to make the perfect sourdough bread.");

    expect(result.score).toBe(0);
    expect(result.matchedInterests).toHaveLength(0);
  });

  test("passesThreshold returns true when above min", () => {
    const filter = new RelevanceFilter({ minScore: 0.6, userInterests: [] }, logger);

    expect(filter.passesThreshold({ score: 0.8, reason: "test", matchedInterests: [] })).toBe(true);
    expect(filter.passesThreshold({ score: 0.6, reason: "test", matchedInterests: [] })).toBe(true);
  });

  test("passesThreshold returns false when below min", () => {
    const filter = new RelevanceFilter({ minScore: 0.6, userInterests: [] }, logger);

    expect(filter.passesThreshold({ score: 0.5, reason: "test", matchedInterests: [] })).toBe(false);
    expect(filter.passesThreshold({ score: 0.0, reason: "test", matchedInterests: [] })).toBe(false);
  });
});

describe("DeduplicationChecker.normalizeUrl", () => {
  test("removes tracking parameters", () => {
    const url = "https://example.com/article?utm_source=twitter&utm_medium=social&id=123";
    const normalized = DeduplicationChecker.normalizeUrl(url);

    expect(normalized).not.toContain("utm_source");
    expect(normalized).not.toContain("utm_medium");
    expect(normalized).toContain("id=123");
  });

  test("removes fragment", () => {
    const url = "https://example.com/article#section-3";
    const normalized = DeduplicationChecker.normalizeUrl(url);

    expect(normalized).not.toContain("#section-3");
  });

  test("removes trailing slashes", () => {
    const url = "https://example.com/article/";
    const normalized = DeduplicationChecker.normalizeUrl(url);

    expect(normalized).toBe("https://example.com/article");
  });

  test("lowercases hostname", () => {
    const url = "https://EXAMPLE.COM/Article";
    const normalized = DeduplicationChecker.normalizeUrl(url);

    expect(normalized).toContain("example.com");
    // Path case should be preserved
    expect(normalized).toContain("/Article");
  });

  test("handles invalid URLs gracefully", () => {
    const url = "not-a-valid-url";
    const normalized = DeduplicationChecker.normalizeUrl(url);

    expect(normalized).toBe("not-a-valid-url");
  });
});
