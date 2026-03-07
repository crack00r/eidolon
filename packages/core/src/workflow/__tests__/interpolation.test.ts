/**
 * Tests for workflow variable interpolation.
 */

import { describe, expect, test } from "bun:test";
import { extractReferences, interpolate, interpolateConfig } from "../interpolation.ts";
import type { WorkflowContext } from "../types.ts";

function makeContext(outputs: Record<string, unknown> = {}): WorkflowContext {
  return {
    runId: "test-run",
    definitionId: "test-def",
    stepOutputs: new Map(Object.entries(outputs)),
    triggerPayload: {},
    variables: {},
  };
}

describe("interpolate", () => {
  test("replaces single placeholder", () => {
    const ctx = makeContext({ research: "TypeScript features" });
    expect(interpolate("Result: {{research.output}}", ctx)).toBe("Result: TypeScript features");
  });

  test("replaces multiple placeholders", () => {
    const ctx = makeContext({ step1: "Hello", step2: "World" });
    expect(interpolate("{{step1.output}} {{step2.output}}", ctx)).toBe("Hello World");
  });

  test("replaces missing placeholder with empty string", () => {
    const ctx = makeContext({});
    expect(interpolate("Result: {{missing.output}}", ctx)).toBe("Result: ");
  });

  test("stringifies non-string output", () => {
    const ctx = makeContext({ data: { key: "value" } });
    expect(interpolate("{{data.output}}", ctx)).toBe('{"key":"value"}');
  });

  test("handles null output", () => {
    const ctx = makeContext({ step1: null });
    expect(interpolate("{{step1.output}}", ctx)).toBe("");
  });

  test("leaves non-matching text unchanged", () => {
    const ctx = makeContext({});
    expect(interpolate("No placeholders here", ctx)).toBe("No placeholders here");
  });

  test("handles numeric output", () => {
    const ctx = makeContext({ count: 42 });
    expect(interpolate("Count: {{count.output}}", ctx)).toBe("Count: 42");
  });
});

describe("interpolateConfig", () => {
  test("interpolates string values in config", () => {
    const ctx = makeContext({ step1: "hello" });
    const config = { prompt: "Say {{step1.output}}", maxTokens: 100 };
    const result = interpolateConfig(config, ctx);
    expect(result.prompt).toBe("Say hello");
    expect(result.maxTokens).toBe(100);
  });

  test("interpolates nested objects", () => {
    const ctx = makeContext({ step1: "value" });
    const config = { nested: { key: "{{step1.output}}" } };
    const result = interpolateConfig(config, ctx);
    expect((result.nested as Record<string, unknown>).key).toBe("value");
  });

  test("interpolates arrays of strings", () => {
    const ctx = makeContext({ step1: "item" });
    const config = { items: ["{{step1.output}}", "static"] };
    const result = interpolateConfig(config, ctx);
    expect(result.items).toEqual(["item", "static"]);
  });
});

describe("extractReferences", () => {
  test("extracts step IDs from template", () => {
    const refs = extractReferences("{{step1.output}} and {{step2.output}}");
    expect(refs).toEqual(["step1", "step2"]);
  });

  test("deduplicates references", () => {
    const refs = extractReferences("{{step1.output}} {{step1.output}}");
    expect(refs).toEqual(["step1"]);
  });

  test("returns empty for no references", () => {
    const refs = extractReferences("No references here");
    expect(refs).toEqual([]);
  });
});
