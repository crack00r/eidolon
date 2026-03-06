/**
 * Tests for router-based relevance scoring.
 *
 * Verifies that createRouterRelevanceScorerFn correctly routes to an LLM provider,
 * sends proper prompts, validates responses, and handles errors.
 */

import { describe, expect, test } from "bun:test";
import type { ILLMProvider, IModelRouter, LLMCompletionOptions, LLMCompletionResult, LLMMessage } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { RelevanceFilter } from "../relevance.ts";
import { createRouterRelevanceScorerFn } from "../router-relevance.ts";

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

function createFakeProvider(responseContent: string): ILLMProvider {
  return {
    type: "ollama",
    name: "Fake Ollama",
    isAvailable: async () => true,
    listModels: async () => ["test-model"],
    complete: async (_messages: readonly LLMMessage[], _options?: LLMCompletionOptions): Promise<LLMCompletionResult> => ({
      content: responseContent,
      usage: { inputTokens: 100, outputTokens: 50 },
      model: "test-model",
      finishReason: "stop",
    }),
    async *stream() {
      yield { type: "done" as const, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function createFakeRouter(provider: ILLMProvider | undefined): IModelRouter {
  return {
    route: () => provider ? [provider.type] : [],
    selectProvider: async () => provider,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRouterRelevanceScorerFn", () => {
  const logger = createSilentLogger();

  test("returns relevance result from valid provider response", async () => {
    const provider = createFakeProvider(
      JSON.stringify({
        score: 0.85,
        reason: "Directly relevant to TypeScript development",
        matchedInterests: ["TypeScript", "AI"],
      }),
    );
    const router = createFakeRouter(provider);
    const scorerFn = createRouterRelevanceScorerFn(router, logger);

    const result = await scorerFn(
      "New TypeScript AI Framework",
      "A framework for building AI apps with TypeScript",
      ["TypeScript", "AI", "self-hosted"],
    );

    expect(result.score).toBe(0.85);
    expect(result.reason).toBe("Directly relevant to TypeScript development");
    expect(result.matchedInterests).toEqual(["TypeScript", "AI"]);
  });

  test("returns zero score for irrelevant content", async () => {
    const provider = createFakeProvider(
      JSON.stringify({
        score: 0.05,
        reason: "Not related to any interest",
        matchedInterests: [],
      }),
    );
    const router = createFakeRouter(provider);
    const scorerFn = createRouterRelevanceScorerFn(router, logger);

    const result = await scorerFn("Best Cookie Recipes", "How to bake cookies", ["TypeScript"]);

    expect(result.score).toBe(0.05);
    expect(result.matchedInterests).toHaveLength(0);
  });

  test("clamps score to [0, 1] range", async () => {
    const provider = createFakeProvider(
      JSON.stringify({
        score: 1.5,
        reason: "test",
        matchedInterests: [],
      }),
    );
    const router = createFakeRouter(provider);
    const scorerFn = createRouterRelevanceScorerFn(router, logger);

    // Zod will reject score > 1, so this should throw
    await expect(scorerFn("Test", "Content", [])).rejects.toThrow("invalid relevance response");
  });

  test("throws when no provider is available", async () => {
    const router = createFakeRouter(undefined);
    const scorerFn = createRouterRelevanceScorerFn(router, logger);

    await expect(scorerFn("Test", "Content", [])).rejects.toThrow("No LLM provider available");
  });

  test("throws on invalid JSON response", async () => {
    const provider = createFakeProvider("This is not JSON at all");
    const router = createFakeRouter(provider);
    const scorerFn = createRouterRelevanceScorerFn(router, logger);

    await expect(scorerFn("Test", "Content", [])).rejects.toThrow("returned no JSON");
  });

  test("throws on missing fields in JSON response", async () => {
    const provider = createFakeProvider(JSON.stringify({ score: 0.5 }));
    const router = createFakeRouter(provider);
    const scorerFn = createRouterRelevanceScorerFn(router, logger);

    await expect(scorerFn("Test", "Content", [])).rejects.toThrow("invalid relevance response");
  });

  test("extracts JSON from response with surrounding text", async () => {
    const provider = createFakeProvider(
      'Here is my analysis:\n{"score": 0.72, "reason": "Relevant to AI development", "matchedInterests": ["AI"]}\nDone.',
    );
    const router = createFakeRouter(provider);
    const scorerFn = createRouterRelevanceScorerFn(router, logger);

    const result = await scorerFn("AI Development Guide", "Guide to building AI apps", ["AI"]);

    expect(result.score).toBe(0.72);
    expect(result.reason).toBe("Relevant to AI development");
  });

  test("integrates with RelevanceFilter as scorerFn", async () => {
    const provider = createFakeProvider(
      JSON.stringify({
        score: 0.88,
        reason: "Highly relevant for self-hosted tooling",
        matchedInterests: ["self-hosted", "AI"],
      }),
    );
    const router = createFakeRouter(provider);
    const scorerFn = createRouterRelevanceScorerFn(router, logger);

    const filter = new RelevanceFilter({ minScore: 0.6, userInterests: ["self-hosted", "AI"] }, logger);

    // Use directly via scoreLlm (bypasses borderline check)
    const result = await filter.scoreLlm("Self-Hosted AI Tools", "Best tools for running AI locally", scorerFn);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.score).toBe(0.88);
    }
  });

  test("passes completion options to provider", async () => {
    let capturedOptions: LLMCompletionOptions | undefined;
    const provider: ILLMProvider = {
      type: "ollama",
      name: "Tracking Provider",
      isAvailable: async () => true,
      listModels: async () => ["test-model"],
      complete: async (_messages, options) => {
        capturedOptions = options;
        return {
          content: JSON.stringify({ score: 0.5, reason: "test", matchedInterests: [] }),
          usage: { inputTokens: 10, outputTokens: 10 },
          model: "test-model",
          finishReason: "stop" as const,
        };
      },
      async *stream() {
        yield { type: "done" as const, usage: { inputTokens: 0, outputTokens: 0 } };
      },
    };
    const router = createFakeRouter(provider);
    const scorerFn = createRouterRelevanceScorerFn(router, logger, {
      completionOptions: { model: "custom-model", temperature: 0.2 },
    });

    await scorerFn("Test", "Content", []);

    expect(capturedOptions?.model).toBe("custom-model");
    expect(capturedOptions?.temperature).toBe(0.2);
  });
});
