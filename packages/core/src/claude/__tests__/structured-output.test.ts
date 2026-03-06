import { describe, expect, test } from "bun:test";
import type { ClaudeSessionOptions } from "@eidolon/protocol";
import { FakeClaudeProcess } from "@eidolon/test-utils";
import { z } from "zod";
import { createLogger } from "../../logging/logger.ts";
import {
  collectTextFromStream,
  extractJson,
  generateSchemaInstruction,
  StructuredOutputParser,
  zodToJsonDescription,
} from "../structured-output.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const logger = createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 10, maxFiles: 1 });

function makeOptions(overrides: Partial<ClaudeSessionOptions> = {}): ClaudeSessionOptions {
  return {
    workspaceDir: "/tmp/test-workspace",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// zodToJsonDescription
// ---------------------------------------------------------------------------

describe("zodToJsonDescription", () => {
  test("describes a simple object schema", () => {
    const schema = z.object({
      name: z.string(),
      age: z.number(),
      active: z.boolean(),
    });

    const desc = zodToJsonDescription(schema);
    expect(desc).toEqual({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
        active: { type: "boolean" },
      },
      required: ["name", "age", "active"],
    });
  });

  test("handles optional fields", () => {
    const schema = z.object({
      name: z.string(),
      nickname: z.string().optional(),
    });

    const desc = zodToJsonDescription(schema);
    const properties = desc.properties as Record<string, Record<string, unknown>>;
    expect(properties.nickname).toEqual({ type: "string", optional: true });
    expect(desc.required as string[]).toEqual(["name"]);
  });

  test("handles arrays", () => {
    const schema = z.object({
      tags: z.array(z.string()),
    });

    const desc = zodToJsonDescription(schema);
    const properties = desc.properties as Record<string, Record<string, unknown>>;
    expect(properties.tags).toEqual({ type: "array", items: { type: "string" } });
  });

  test("handles enums", () => {
    const schema = z.object({
      status: z.enum(["active", "inactive", "pending"]),
    });

    const desc = zodToJsonDescription(schema);
    const properties = desc.properties as Record<string, Record<string, unknown>>;
    expect(properties.status).toEqual({ type: "string", enum: ["active", "inactive", "pending"] });
  });

  test("handles nested objects", () => {
    const schema = z.object({
      user: z.object({
        name: z.string(),
      }),
    });

    const desc = zodToJsonDescription(schema);
    const properties = desc.properties as Record<string, Record<string, unknown>>;
    expect(properties.user).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
  });

  test("handles nullable fields", () => {
    const schema = z.object({
      value: z.string().nullable(),
    });

    const desc = zodToJsonDescription(schema);
    const properties = desc.properties as Record<string, Record<string, unknown>>;
    expect(properties.value).toEqual({ type: "string", nullable: true });
  });
});

// ---------------------------------------------------------------------------
// generateSchemaInstruction
// ---------------------------------------------------------------------------

describe("generateSchemaInstruction", () => {
  test("generates instruction with schema description", () => {
    const schema = z.object({ name: z.string() });
    const instruction = generateSchemaInstruction(schema);

    expect(instruction).toContain("You MUST respond with ONLY valid JSON");
    expect(instruction).toContain("Do NOT include any text");
    expect(instruction).toContain('"type": "object"');
    expect(instruction).toContain('"name"');
  });

  test("includes the word 'string' for string fields", () => {
    const schema = z.object({ title: z.string() });
    const instruction = generateSchemaInstruction(schema);
    expect(instruction).toContain('"type": "string"');
  });
});

// ---------------------------------------------------------------------------
// extractJson
// ---------------------------------------------------------------------------

describe("extractJson", () => {
  test("extracts pure JSON object", () => {
    const input = '{"name": "test", "value": 42}';
    expect(extractJson(input)).toBe(input);
  });

  test("extracts pure JSON array", () => {
    const input = "[1, 2, 3]";
    expect(extractJson(input)).toBe(input);
  });

  test("extracts JSON from markdown code fence", () => {
    const input = 'Here is the result:\n```json\n{"name": "test"}\n```\nDone.';
    expect(extractJson(input)).toBe('{"name": "test"}');
  });

  test("extracts JSON from code fence without json label", () => {
    const input = '```\n{"name": "test"}\n```';
    expect(extractJson(input)).toBe('{"name": "test"}');
  });

  test("extracts JSON embedded in text", () => {
    const input = 'Sure, here you go: {"name": "test"} Hope that helps!';
    expect(extractJson(input)).toBe('{"name": "test"}');
  });

  test("handles nested braces correctly", () => {
    const input = 'Result: {"outer": {"inner": "value"}}';
    expect(extractJson(input)).toBe('{"outer": {"inner": "value"}}');
  });

  test("handles braces inside strings", () => {
    const input = '{"text": "contains {braces} inside"}';
    expect(extractJson(input)).toBe('{"text": "contains {braces} inside"}');
  });

  test("handles escaped quotes in strings", () => {
    const input = '{"text": "she said \\"hello\\""}';
    expect(extractJson(input)).toBe('{"text": "she said \\"hello\\""}');
  });

  test("returns null for no JSON", () => {
    expect(extractJson("no json here")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(extractJson("")).toBeNull();
  });

  test("extracts array from text", () => {
    const input = "The items are: [1, 2, 3] done.";
    expect(extractJson(input)).toBe("[1, 2, 3]");
  });

  test("prefers object over array when object appears first", () => {
    const input = 'data: {"a": 1} or [1,2]';
    expect(extractJson(input)).toBe('{"a": 1}');
  });

  test("handles whitespace-padded JSON", () => {
    const input = '   {"name": "test"}   ';
    expect(extractJson(input)).toBe('{"name": "test"}');
  });
});

// ---------------------------------------------------------------------------
// collectTextFromStream
// ---------------------------------------------------------------------------

describe("collectTextFromStream", () => {
  test("collects text from multiple events", async () => {
    async function* events() {
      yield { type: "text" as const, content: "Hello ", timestamp: Date.now() };
      yield { type: "text" as const, content: "world", timestamp: Date.now() };
      yield { type: "done" as const, timestamp: Date.now() };
    }
    const text = await collectTextFromStream(events());
    expect(text).toBe("Hello world");
  });

  test("ignores non-text events", async () => {
    async function* events() {
      yield { type: "system" as const, content: "Starting...", timestamp: Date.now() };
      yield { type: "text" as const, content: "result", timestamp: Date.now() };
      yield { type: "tool_use" as const, toolName: "Read", timestamp: Date.now() };
      yield { type: "done" as const, timestamp: Date.now() };
    }
    const text = await collectTextFromStream(events());
    expect(text).toBe("result");
  });

  test("returns empty string for no text events", async () => {
    async function* events() {
      yield { type: "done" as const, timestamp: Date.now() };
    }
    const text = await collectTextFromStream(events());
    expect(text).toBe("");
  });
});

// ---------------------------------------------------------------------------
// StructuredOutputParser.parseResponse (no Claude needed)
// ---------------------------------------------------------------------------

describe("StructuredOutputParser.parseResponse", () => {
  const schema = z.object({
    facts: z.array(z.string()),
    confidence: z.number().min(0).max(1),
  });

  // Use a no-op fake -- parseResponse does not call Claude
  const fake = FakeClaudeProcess.withResponse(/./, "unused");
  const parser = new StructuredOutputParser(schema, fake, logger);

  test("parses valid JSON response", () => {
    const result = parser.parseResponse('{"facts": ["TypeScript is typed"], "confidence": 0.9}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.facts).toEqual(["TypeScript is typed"]);
      expect(result.value.confidence).toBe(0.9);
    }
  });

  test("parses JSON from markdown code fence", () => {
    const result = parser.parseResponse('```json\n{"facts": ["test"], "confidence": 0.5}\n```');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.facts).toEqual(["test"]);
    }
  });

  test("returns error for invalid JSON", () => {
    const result = parser.parseResponse("not json at all");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STRUCTURED_OUTPUT_PARSE_FAILED");
      expect(result.error.message).toContain("No valid JSON");
    }
  });

  test("returns error for malformed JSON", () => {
    const result = parser.parseResponse("{bad json}");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STRUCTURED_OUTPUT_PARSE_FAILED");
      expect(result.error.message).toContain("JSON parse error");
    }
  });

  test("returns error when schema validation fails", () => {
    const result = parser.parseResponse('{"facts": "not an array", "confidence": 0.5}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STRUCTURED_OUTPUT_PARSE_FAILED");
      expect(result.error.message).toContain("Schema validation failed");
    }
  });

  test("returns error when required field is missing", () => {
    const result = parser.parseResponse('{"facts": ["test"]}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Schema validation failed");
      expect(result.error.message).toContain("confidence");
    }
  });

  test("returns error when number is out of range", () => {
    const result = parser.parseResponse('{"facts": ["test"], "confidence": 1.5}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Schema validation failed");
    }
  });
});

// ---------------------------------------------------------------------------
// StructuredOutputParser.parse (with FakeClaudeProcess)
// ---------------------------------------------------------------------------

describe("StructuredOutputParser.parse", () => {
  const schema = z.object({
    score: z.number(),
    reason: z.string(),
  });

  test("succeeds on first attempt with valid JSON response", async () => {
    const validJson = '{"score": 85, "reason": "Highly relevant"}';
    const fake = FakeClaudeProcess.withResponse(/./, validJson);
    const parser = new StructuredOutputParser(schema, fake, logger);

    const result = await parser.parse("Score this content", makeOptions());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.score).toBe(85);
      expect(result.value.reason).toBe("Highly relevant");
    }
    expect(fake.getCallCount()).toBe(1);
  });

  test("retries on validation failure and succeeds", async () => {
    const fake = new FakeClaudeProcess();
    const _callCount = 0;

    // Use a regex-based rule that checks call count via the prompt content.
    // First call has the original prompt, retry has "Your previous response" at the start.
    fake.addRule(/^Your previous response/, [
      { type: "text", content: '{"score": 85, "reason": "Fixed"}', timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    // This rule matches the initial prompt (must be added after the retry rule
    // since FakeClaudeProcess checks rules in order, and the initial prompt
    // does NOT start with "Your previous response")
    fake.addRule(/^Score this content/, [
      { type: "text", content: '{"score": 85}', timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    const parser = new StructuredOutputParser(schema, fake, logger);
    const result = await parser.parse("Score this content", makeOptions());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.reason).toBe("Fixed");
    }
    expect(fake.getCallCount()).toBe(2);
  });

  test("fails after max retries exhausted", async () => {
    // Always returns invalid JSON
    const fake = FakeClaudeProcess.withResponse(/./, '{"invalid": true}');
    const parser = new StructuredOutputParser(schema, fake, logger, { maxRetries: 2 });

    const result = await parser.parse("Score this", makeOptions());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("STRUCTURED_OUTPUT_PARSE_FAILED");
      expect(result.error.message).toContain("after 2 retries");
    }
    // 1 initial + 2 retries = 3 calls
    expect(fake.getCallCount()).toBe(3);
  });

  test("fails when Claude returns empty response", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "");
    const parser = new StructuredOutputParser(schema, fake, logger, { maxRetries: 0 });

    const result = await parser.parse("Score this", makeOptions());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("empty response");
    }
  });

  test("appends schema instruction to system prompt", async () => {
    const validJson = '{"score": 1, "reason": "ok"}';
    const fake = FakeClaudeProcess.withResponse(/./, validJson);
    const parser = new StructuredOutputParser(schema, fake, logger);

    await parser.parse("Test prompt", makeOptions({ systemPrompt: "Be helpful." }));

    const lastOptions = fake.getLastOptions();
    expect(lastOptions?.systemPrompt).toContain("Be helpful.");
    expect(lastOptions?.systemPrompt).toContain("You MUST respond with ONLY valid JSON");
  });

  test("works without existing system prompt", async () => {
    const validJson = '{"score": 1, "reason": "ok"}';
    const fake = FakeClaudeProcess.withResponse(/./, validJson);
    const parser = new StructuredOutputParser(schema, fake, logger);

    await parser.parse("Test prompt", makeOptions());

    const lastOptions = fake.getLastOptions();
    expect(lastOptions?.systemPrompt).toContain("You MUST respond with ONLY valid JSON");
  });

  test("custom maxRetries is respected", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, '{"bad": true}');
    const parser = new StructuredOutputParser(schema, fake, logger, { maxRetries: 1 });

    const result = await parser.parse("Test", makeOptions());
    expect(result.ok).toBe(false);
    // 1 initial + 1 retry = 2 calls
    expect(fake.getCallCount()).toBe(2);
  });

  test("zero retries means single attempt only", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, '{"bad": true}');
    const parser = new StructuredOutputParser(schema, fake, logger, { maxRetries: 0 });

    const result = await parser.parse("Test", makeOptions());
    expect(result.ok).toBe(false);
    expect(fake.getCallCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: complex schema
// ---------------------------------------------------------------------------

describe("StructuredOutputParser with complex schema", () => {
  const memoryExtractionSchema = z.object({
    facts: z.array(
      z.object({
        content: z.string(),
        type: z.enum(["fact", "preference", "decision"]),
        confidence: z.number().min(0).max(1),
        tags: z.array(z.string()),
      }),
    ),
    metadata: z
      .object({
        turnCount: z.number(),
        language: z.string(),
      })
      .optional(),
  });

  test("parses complex nested response", async () => {
    const validResponse = JSON.stringify({
      facts: [
        { content: "User prefers TypeScript", type: "preference", confidence: 0.9, tags: ["tech"] },
        { content: "Decided on Bun runtime", type: "decision", confidence: 0.95, tags: ["tech", "runtime"] },
      ],
      metadata: { turnCount: 3, language: "en" },
    });

    const fake = FakeClaudeProcess.withResponse(/./, validResponse);
    const parser = new StructuredOutputParser(memoryExtractionSchema, fake, logger);

    const result = await parser.parse("Extract memories", makeOptions());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.facts).toHaveLength(2);
      expect(result.value.facts[0]?.type).toBe("preference");
      expect(result.value.metadata?.turnCount).toBe(3);
    }
  });

  test("validates enum values strictly", async () => {
    const invalidResponse = JSON.stringify({
      facts: [{ content: "test", type: "invalid_type", confidence: 0.5, tags: [] }],
    });

    const fake = FakeClaudeProcess.withResponse(/./, invalidResponse);
    const parser = new StructuredOutputParser(memoryExtractionSchema, fake, logger, { maxRetries: 0 });

    const result = await parser.parse("Extract", makeOptions());
    expect(result.ok).toBe(false);
  });

  test("handles optional metadata correctly", async () => {
    const responseWithoutMetadata = JSON.stringify({
      facts: [{ content: "test", type: "fact", confidence: 0.8, tags: [] }],
    });

    const fake = FakeClaudeProcess.withResponse(/./, responseWithoutMetadata);
    const parser = new StructuredOutputParser(memoryExtractionSchema, fake, logger);

    const result = await parser.parse("Extract", makeOptions());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.metadata).toBeUndefined();
    }
  });
});
