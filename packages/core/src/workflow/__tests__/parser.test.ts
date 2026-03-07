/**
 * Tests for WorkflowParser.
 */

import { describe, expect, test } from "bun:test";
import { FakeClaudeProcess } from "@eidolon/test-utils";
import type { Logger } from "../../logging/logger.ts";
import { WorkflowParser } from "../parser.ts";

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}

describe("WorkflowParser", () => {
  test("parses a valid workflow from LLM response", async () => {
    const workflowJson = JSON.stringify({
      id: "wf-test",
      name: "Test Workflow",
      description: "A test",
      trigger: { type: "manual" },
      steps: [
        {
          id: "step1",
          name: "Research",
          type: "llm_call",
          config: { prompt: "Research AI", outputKey: "findings" },
          dependsOn: [],
        },
      ],
      onFailure: { type: "abort" },
      createdAt: Date.now(),
      createdBy: "user",
      maxDurationMs: 1800000,
      metadata: {},
    });

    const fake = FakeClaudeProcess.withResponse(/./, workflowJson);
    const parser = new WorkflowParser(fake, "/tmp", createSilentLogger());

    const result = await parser.parse("Research AI topics");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Test Workflow");
      expect(result.value.steps).toHaveLength(1);
    }
  });

  test("handles markdown-fenced JSON response", async () => {
    const workflowJson = JSON.stringify({
      id: "wf-test",
      name: "Fenced Workflow",
      trigger: { type: "manual" },
      steps: [
        {
          id: "s1",
          name: "Step",
          type: "llm_call",
          config: { prompt: "hello", outputKey: "out" },
          dependsOn: [],
        },
      ],
      createdAt: Date.now(),
    });

    const response = `\`\`\`json\n${workflowJson}\n\`\`\``;
    const fake = FakeClaudeProcess.withResponse(/./, response);
    const parser = new WorkflowParser(fake, "/tmp", createSilentLogger());

    const result = await parser.parse("Do something");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("Fenced Workflow");
    }
  });

  test("returns error for invalid JSON response", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "This is not JSON at all");
    const parser = new WorkflowParser(fake, "/tmp", createSilentLogger());

    const result = await parser.parse("Do something");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("JSON");
    }
  });

  test("returns error for valid JSON but invalid schema", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, JSON.stringify({ invalid: true }));
    const parser = new WorkflowParser(fake, "/tmp", createSilentLogger());

    const result = await parser.parse("Do something");
    expect(result.ok).toBe(false);
  });

  test("returns error when Claude returns an error event", async () => {
    const fake = FakeClaudeProcess.withError("CLAUDE_PROCESS_CRASHED" as never, "Claude crashed");
    const parser = new WorkflowParser(fake, "/tmp", createSilentLogger());

    const result = await parser.parse("Do something");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("error");
    }
  });
});
