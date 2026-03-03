import { describe, expect, test } from "bun:test";
import type { ClaudeSessionOptions } from "@eidolon/protocol";
import { FakeClaudeProcess } from "@eidolon/test-utils";
import type { Logger } from "../../logging/logger.ts";
import { RelevanceFilter } from "../relevance.ts";
import type { RelevanceResponse } from "../structured-relevance.ts";
import { createStructuredRelevanceScorerFn, RelevanceResponseSchema } from "../structured-relevance.ts";

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

function makeSessionOptions(): ClaudeSessionOptions {
  return { workspaceDir: "/tmp/test-workspace" };
}

/**
 * Create a FakeClaudeProcess that responds with a valid relevance JSON.
 */
function fakeWithRelevanceResponse(response: RelevanceResponse): FakeClaudeProcess {
  return FakeClaudeProcess.withResponse(/./, JSON.stringify(response));
}

// ---------------------------------------------------------------------------
// RelevanceResponseSchema
// ---------------------------------------------------------------------------

describe("RelevanceResponseSchema", () => {
  test("accepts valid relevance response", () => {
    const input: RelevanceResponse = {
      score: 0.85,
      reason: "Directly relevant to TypeScript development",
      matchedInterests: ["TypeScript", "AI"],
    };

    const result = RelevanceResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("accepts zero score with empty matches", () => {
    const input: RelevanceResponse = {
      score: 0,
      reason: "Not relevant",
      matchedInterests: [],
    };

    const result = RelevanceResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("rejects score above 1", () => {
    const result = RelevanceResponseSchema.safeParse({
      score: 1.5,
      reason: "test",
      matchedInterests: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects score below 0", () => {
    const result = RelevanceResponseSchema.safeParse({
      score: -0.1,
      reason: "test",
      matchedInterests: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects empty reason", () => {
    const result = RelevanceResponseSchema.safeParse({
      score: 0.5,
      reason: "",
      matchedInterests: [],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing fields", () => {
    expect(RelevanceResponseSchema.safeParse({}).success).toBe(false);
    expect(RelevanceResponseSchema.safeParse({ score: 0.5 }).success).toBe(false);
    expect(RelevanceResponseSchema.safeParse({ score: 0.5, reason: "test" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createStructuredRelevanceScorerFn
// ---------------------------------------------------------------------------

describe("createStructuredRelevanceScorerFn", () => {
  const logger = createSilentLogger();

  test("returns relevance result from valid Claude response", async () => {
    const response: RelevanceResponse = {
      score: 0.85,
      reason: "Directly relevant to TypeScript development",
      matchedInterests: ["TypeScript", "AI"],
    };
    const fake = fakeWithRelevanceResponse(response);

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    const result = await scorerFn(
      "New TypeScript AI Framework",
      "A new framework for building AI apps with TypeScript...",
      ["TypeScript", "AI", "self-hosted"],
    );

    expect(result.score).toBe(0.85);
    expect(result.reason).toBe("Directly relevant to TypeScript development");
    expect(result.matchedInterests).toEqual(["TypeScript", "AI"]);
  });

  test("returns zero score for irrelevant content", async () => {
    const response: RelevanceResponse = {
      score: 0.1,
      reason: "Not related to any user interests",
      matchedInterests: [],
    };
    const fake = fakeWithRelevanceResponse(response);

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    const result = await scorerFn("Best Cookie Recipes", "How to bake the perfect chocolate chip cookie...", [
      "TypeScript",
      "AI",
    ]);

    expect(result.score).toBe(0.1);
    expect(result.matchedInterests).toHaveLength(0);
  });

  test("throws on invalid Claude response", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "not valid JSON");

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
      maxRetries: 0,
    });

    await expect(scorerFn("Test", "Content", ["interest"])).rejects.toThrow("Structured relevance scoring failed");
  });

  test("sends title and content in prompt", async () => {
    const response: RelevanceResponse = {
      score: 0.5,
      reason: "Somewhat relevant",
      matchedInterests: [],
    };
    const fake = fakeWithRelevanceResponse(response);

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    await scorerFn("sqlite-vec 0.2.0 Released", "New version of sqlite-vec with 3x faster search", [
      "SQLite",
      "vector search",
    ]);

    const lastPrompt = fake.getLastPrompt();
    expect(lastPrompt).toContain("sqlite-vec 0.2.0 Released");
    expect(lastPrompt).toContain("3x faster search");
    expect(lastPrompt).toContain("SQLite");
    expect(lastPrompt).toContain("vector search");
  });

  test("sends interests in prompt", async () => {
    const response: RelevanceResponse = {
      score: 0.7,
      reason: "Relevant",
      matchedInterests: ["Bun"],
    };
    const fake = fakeWithRelevanceResponse(response);

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    await scorerFn("Bun 1.2 Released", "Major update to the Bun JavaScript runtime", ["Bun", "TypeScript", "SQLite"]);

    const lastPrompt = fake.getLastPrompt();
    expect(lastPrompt).toContain("- Bun");
    expect(lastPrompt).toContain("- TypeScript");
    expect(lastPrompt).toContain("- SQLite");
  });

  test("passes custom system prompt to session options", async () => {
    const response: RelevanceResponse = {
      score: 0.5,
      reason: "test",
      matchedInterests: [],
    };
    const fake = fakeWithRelevanceResponse(response);

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
      systemPrompt: "Custom relevance evaluator context",
    });

    await scorerFn("Test Title", "Test content", []);

    const lastOptions = fake.getLastOptions();
    expect(lastOptions?.systemPrompt).toContain("Custom relevance evaluator context");
  });

  test("uses default system prompt when none provided", async () => {
    const response: RelevanceResponse = {
      score: 0.5,
      reason: "test",
      matchedInterests: [],
    };
    const fake = fakeWithRelevanceResponse(response);

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    await scorerFn("Test Title", "Test content", []);

    const lastOptions = fake.getLastOptions();
    expect(lastOptions?.systemPrompt).toContain("content relevance evaluator");
  });
});

// ---------------------------------------------------------------------------
// Integration with RelevanceFilter
// ---------------------------------------------------------------------------

describe("RelevanceFilter + structured relevance integration", () => {
  const logger = createSilentLogger();

  test("works as scorerFn in RelevanceFilter.score()", async () => {
    const response: RelevanceResponse = {
      score: 0.85,
      reason: "Highly relevant AI tooling article",
      matchedInterests: ["AI", "TypeScript"],
    };
    const fake = fakeWithRelevanceResponse(response);

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    const filter = new RelevanceFilter({ minScore: 0.6, userInterests: ["AI", "TypeScript"] }, logger);

    // Use a borderline keyword score so the filter triggers LLM scoring
    const result = await filter.score(
      "New AI Framework for Development",
      "A comprehensive article about modern AI development patterns.",
      scorerFn,
    );

    // The keyword score for this is borderline (has AI match + tech keyword),
    // so it should use the LLM scorer, which returns 0.85
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  test("works as scorerFn in RelevanceFilter.scoreLlm()", async () => {
    const response: RelevanceResponse = {
      score: 0.9,
      reason: "Directly actionable for the project",
      matchedInterests: ["SQLite", "performance"],
    };
    const fake = fakeWithRelevanceResponse(response);

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    const filter = new RelevanceFilter({ minScore: 0.6, userInterests: ["SQLite", "performance"] }, logger);

    const result = await filter.scoreLlm("sqlite-vec 0.2.0 Released", "3x faster vector search in SQLite", scorerFn);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.score).toBe(0.9);
    expect(result.value.reason).toBe("Directly actionable for the project");
    expect(result.value.matchedInterests).toEqual(["SQLite", "performance"]);
  });

  test("filter returns error when structured scorer fails", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "garbage output");

    const scorerFn = createStructuredRelevanceScorerFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
      maxRetries: 0,
    });

    const filter = new RelevanceFilter({ minScore: 0.6, userInterests: ["test"] }, logger);

    const result = await filter.scoreLlm("Test", "Content", scorerFn);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("DISCOVERY_FAILED");
  });
});
