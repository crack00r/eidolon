import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { ClaudeSessionOptions } from "@eidolon/protocol";
import { FakeClaudeProcess } from "@eidolon/test-utils";
import type { Logger } from "../../logging/logger.ts";
import { MemoryExtractor } from "../extractor.ts";
import type { ExtractionResponse } from "../structured-extract.ts";
import {
  createStructuredLlmExtractFn,
  ExtractionResponseSchema,
} from "../structured-extract.ts";

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
 * Create a FakeClaudeProcess that responds with a valid extraction JSON.
 */
function fakeWithExtractionResponse(response: ExtractionResponse): FakeClaudeProcess {
  return FakeClaudeProcess.withResponse(/./, JSON.stringify(response));
}

// ---------------------------------------------------------------------------
// ExtractionResponseSchema
// ---------------------------------------------------------------------------

describe("ExtractionResponseSchema", () => {
  test("accepts valid extraction response", () => {
    const input: ExtractionResponse = {
      memories: [
        { type: "fact", content: "User prefers TypeScript", confidence: 0.9, tags: ["tech"] },
        { type: "preference", content: "Dark mode always", confidence: 0.85, tags: ["ui"] },
      ],
    };

    const result = ExtractionResponseSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  test("accepts empty memories array", () => {
    const result = ExtractionResponseSchema.safeParse({ memories: [] });
    expect(result.success).toBe(true);
  });

  test("rejects invalid memory type", () => {
    const result = ExtractionResponseSchema.safeParse({
      memories: [{ type: "invalid_type", content: "test", confidence: 0.5, tags: [] }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects confidence out of range", () => {
    const resultHigh = ExtractionResponseSchema.safeParse({
      memories: [{ type: "fact", content: "test", confidence: 1.5, tags: [] }],
    });
    expect(resultHigh.success).toBe(false);

    const resultLow = ExtractionResponseSchema.safeParse({
      memories: [{ type: "fact", content: "test", confidence: -0.1, tags: [] }],
    });
    expect(resultLow.success).toBe(false);
  });

  test("rejects empty content", () => {
    const result = ExtractionResponseSchema.safeParse({
      memories: [{ type: "fact", content: "", confidence: 0.5, tags: [] }],
    });
    expect(result.success).toBe(false);
  });

  test("rejects missing memories field", () => {
    const result = ExtractionResponseSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createStructuredLlmExtractFn
// ---------------------------------------------------------------------------

describe("createStructuredLlmExtractFn", () => {
  const logger = createSilentLogger();

  test("returns extracted memories from valid Claude response", async () => {
    const response: ExtractionResponse = {
      memories: [
        { type: "fact", content: "Server runs Ubuntu 22.04", confidence: 0.95, tags: ["system"] },
        { type: "preference", content: "User likes dark mode", confidence: 0.85, tags: ["ui"] },
      ],
    };
    const fake = fakeWithExtractionResponse(response);

    const extractFn = createStructuredLlmExtractFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    const results = await extractFn({
      userMessage: "My server runs Ubuntu 22.04 and I like dark mode",
      assistantResponse: "Noted.",
    });

    expect(results).toHaveLength(2);
    expect(results[0]?.type).toBe("fact");
    expect(results[0]?.content).toBe("Server runs Ubuntu 22.04");
    expect(results[0]?.confidence).toBe(0.95);
    expect(results[0]?.tags).toEqual(["system"]);
    expect(results[0]?.source).toBe("llm");
    expect(results[0]?.sensitive).toBe(false);

    expect(results[1]?.type).toBe("preference");
    expect(results[1]?.content).toBe("User likes dark mode");
  });

  test("returns empty array when no memories extracted", async () => {
    const response: ExtractionResponse = { memories: [] };
    const fake = fakeWithExtractionResponse(response);

    const extractFn = createStructuredLlmExtractFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    const results = await extractFn({
      userMessage: "ok",
      assistantResponse: "Sure.",
    });

    expect(results).toHaveLength(0);
  });

  test("throws on invalid Claude response", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "this is not JSON at all");

    const extractFn = createStructuredLlmExtractFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
      maxRetries: 0, // No retries to make test fast
    });

    await expect(
      extractFn({
        userMessage: "Test message with enough content to extract",
        assistantResponse: "Noted.",
      }),
    ).rejects.toThrow("Structured extraction failed");
  });

  test("sends conversation turn in the prompt", async () => {
    const response: ExtractionResponse = { memories: [] };
    const fake = fakeWithExtractionResponse(response);

    const extractFn = createStructuredLlmExtractFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    await extractFn({
      userMessage: "I prefer TypeScript over Python",
      assistantResponse: "Good choice for Eidolon!",
    });

    const lastPrompt = fake.getLastPrompt();
    expect(lastPrompt).toContain("I prefer TypeScript over Python");
    expect(lastPrompt).toContain("Good choice for Eidolon!");
    expect(lastPrompt).toContain("USER MESSAGE:");
    expect(lastPrompt).toContain("ASSISTANT RESPONSE:");
  });

  test("passes system prompt to session options", async () => {
    const response: ExtractionResponse = { memories: [] };
    const fake = fakeWithExtractionResponse(response);

    const extractFn = createStructuredLlmExtractFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
      systemPrompt: "Custom extraction context",
    });

    await extractFn({
      userMessage: "Test message with plenty of content",
      assistantResponse: "Noted.",
    });

    const lastOptions = fake.getLastOptions();
    expect(lastOptions?.systemPrompt).toContain("Custom extraction context");
  });

  test("uses default system prompt when none provided", async () => {
    const response: ExtractionResponse = { memories: [] };
    const fake = fakeWithExtractionResponse(response);

    const extractFn = createStructuredLlmExtractFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    await extractFn({
      userMessage: "Test message with plenty of content",
      assistantResponse: "Noted.",
    });

    const lastOptions = fake.getLastOptions();
    expect(lastOptions?.systemPrompt).toContain("memory extraction assistant");
  });
});

// ---------------------------------------------------------------------------
// Integration with MemoryExtractor
// ---------------------------------------------------------------------------

describe("MemoryExtractor + structured extract integration", () => {
  const logger = createSilentLogger();

  test("works as llmExtractFn in hybrid strategy", async () => {
    const response: ExtractionResponse = {
      memories: [
        { type: "fact", content: "User's GPU is RTX 5080", confidence: 0.9, tags: ["hardware"] },
      ],
    };
    const fake = fakeWithExtractionResponse(response);

    const extractFn = createStructuredLlmExtractFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    const extractor = new MemoryExtractor(logger, {
      strategy: "hybrid",
      llmExtractFn: extractFn,
    });

    const result = await extractor.extract({
      userMessage: "My GPU is an RTX 5080 with 16GB VRAM",
      assistantResponse: "That's a powerful GPU!",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have LLM-extracted memory
    const llmMemory = result.value.find((m) => m.source === "llm");
    expect(llmMemory).toBeDefined();
    expect(llmMemory?.content).toBe("User's GPU is RTX 5080");
    expect(llmMemory?.type).toBe("fact");
  });

  test("MemoryExtractor falls back to rule-based when structured extract fails", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "completely invalid response");

    const extractFn = createStructuredLlmExtractFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
      maxRetries: 0,
    });

    const extractor = new MemoryExtractor(logger, {
      strategy: "hybrid",
      llmExtractFn: extractFn,
    });

    const result = await extractor.extract({
      userMessage: "Remember that my server IP is 192.168.1.100",
      assistantResponse: "Noted.",
    });

    // Should succeed via rule-based fallback
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThanOrEqual(1);
    expect(result.value.every((m) => m.source === "rule_based")).toBe(true);
  });

  test("multiple memories from structured extraction", async () => {
    const response: ExtractionResponse = {
      memories: [
        { type: "fact", content: "User runs Ubuntu server", confidence: 0.95, tags: ["system"] },
        { type: "preference", content: "Prefers dark mode", confidence: 0.85, tags: ["ui"] },
        { type: "decision", content: "Chose TypeScript for core", confidence: 0.9, tags: ["tech"] },
      ],
    };
    const fake = fakeWithExtractionResponse(response);

    const extractFn = createStructuredLlmExtractFn(fake, logger, {
      sessionOptions: makeSessionOptions(),
    });

    const results = await extractFn({
      userMessage: "We run Ubuntu, prefer dark mode, and chose TypeScript",
      assistantResponse: "Good choices.",
    });

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.type)).toEqual(["fact", "preference", "decision"]);
  });
});
