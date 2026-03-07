/**
 * Tests for step executors.
 */

import { describe, expect, test } from "bun:test";
import { ApiStepExecutor } from "../executors/api.ts";
import { ConditionStepExecutor, evaluateCondition } from "../executors/condition.ts";
import { TransformStepExecutor } from "../executors/transform.ts";
import { WaitStepExecutor } from "../executors/wait.ts";
import type { WorkflowContext } from "../types.ts";

function makeContext(outputs: Record<string, unknown> = {}, trigger: unknown = {}): WorkflowContext {
  return {
    runId: "test-run",
    definitionId: "test-def",
    stepOutputs: new Map(Object.entries(outputs)),
    triggerPayload: trigger,
    variables: {},
  };
}

function makeSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// evaluateCondition
// ---------------------------------------------------------------------------

describe("evaluateCondition", () => {
  test("compares numbers with >", () => {
    const ctx = makeContext({}, { temperature: 15 });
    expect(evaluateCondition("trigger.temperature < 18", ctx)).toBe(true);
    expect(evaluateCondition("trigger.temperature > 18", ctx)).toBe(false);
  });

  test("compares with ==", () => {
    const ctx = makeContext({ step1: "hello" });
    expect(evaluateCondition('step1.output == "hello"', ctx)).toBe(true);
    expect(evaluateCondition('step1.output == "world"', ctx)).toBe(false);
  });

  test("compares with !=", () => {
    const ctx = makeContext({ step1: "hello" });
    expect(evaluateCondition('step1.output != "world"', ctx)).toBe(true);
    expect(evaluateCondition('step1.output != "hello"', ctx)).toBe(false);
  });

  test("supports contains", () => {
    const ctx = makeContext({ step1: "hello world" });
    expect(evaluateCondition('step1.output contains "world"', ctx)).toBe(true);
    expect(evaluateCondition('step1.output contains "xyz"', ctx)).toBe(false);
  });

  test("supports && compound", () => {
    const ctx = makeContext({}, { a: 5, b: 10 });
    expect(evaluateCondition("trigger.a > 3 && trigger.b > 8", ctx)).toBe(true);
    expect(evaluateCondition("trigger.a > 3 && trigger.b > 15", ctx)).toBe(false);
  });

  test("supports || compound", () => {
    const ctx = makeContext({}, { a: 1, b: 10 });
    expect(evaluateCondition("trigger.a > 5 || trigger.b > 8", ctx)).toBe(true);
    expect(evaluateCondition("trigger.a > 5 || trigger.b > 15", ctx)).toBe(false);
  });

  test("compares with >= and <=", () => {
    const ctx = makeContext({}, { val: 18 });
    expect(evaluateCondition("trigger.val >= 18", ctx)).toBe(true);
    expect(evaluateCondition("trigger.val <= 18", ctx)).toBe(true);
    expect(evaluateCondition("trigger.val >= 19", ctx)).toBe(false);
  });

  test("returns false for unparseable expression", () => {
    const ctx = makeContext();
    expect(evaluateCondition("nonsense", ctx)).toBe(false);
  });

  test("compares boolean true", () => {
    const ctx = makeContext({ step1: true });
    expect(evaluateCondition("step1.output == true", ctx)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ConditionStepExecutor
// ---------------------------------------------------------------------------

describe("ConditionStepExecutor", () => {
  test("executes condition and returns boolean", async () => {
    const executor = new ConditionStepExecutor();
    const ctx = makeContext({}, { state: 15 });

    const result = await executor.execute(
      { expression: "trigger.state < 18", thenSteps: ["a"], elseSteps: ["b"] },
      ctx,
      makeSignal(),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe(true);
    }
  });

  test("returns error for invalid config", async () => {
    const executor = new ConditionStepExecutor();
    const result = await executor.execute({}, makeContext(), makeSignal());
    expect(result.ok).toBe(false);
  });

  test("returns error when aborted", async () => {
    const executor = new ConditionStepExecutor();
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute(
      { expression: "1 == 1", thenSteps: [], elseSteps: [] },
      makeContext(),
      controller.signal,
    );
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TransformStepExecutor
// ---------------------------------------------------------------------------

describe("TransformStepExecutor", () => {
  test("applies uppercase transform", async () => {
    const executor = new TransformStepExecutor();
    const ctx = makeContext({ step1: "hello" });
    const result = await executor.execute(
      { input: "{{step1.output}}", expression: "uppercase", outputKey: "result" },
      ctx,
      makeSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe("HELLO");
    }
  });

  test("applies lowercase transform", async () => {
    const executor = new TransformStepExecutor();
    const ctx = makeContext({ step1: "HELLO" });
    const result = await executor.execute(
      { input: "{{step1.output}}", expression: "lowercase", outputKey: "result" },
      ctx,
      makeSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe("hello");
    }
  });

  test("applies trim transform", async () => {
    const executor = new TransformStepExecutor();
    const ctx = makeContext({ step1: "  hello  " });
    const result = await executor.execute(
      { input: "{{step1.output}}", expression: "trim", outputKey: "result" },
      ctx,
      makeSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe("hello");
    }
  });

  test("applies length transform", async () => {
    const executor = new TransformStepExecutor();
    const ctx = makeContext({ step1: "hello" });
    const result = await executor.execute(
      { input: "{{step1.output}}", expression: "length", outputKey: "result" },
      ctx,
      makeSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe(5);
    }
  });

  test("applies piped transforms", async () => {
    const executor = new TransformStepExecutor();
    const ctx = makeContext({ step1: "  Hello  " });
    const result = await executor.execute(
      { input: "{{step1.output}}", expression: "trim | uppercase", outputKey: "result" },
      ctx,
      makeSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe("HELLO");
    }
  });

  test("applies json_extract transform", async () => {
    const executor = new TransformStepExecutor();
    const ctx = makeContext({ step1: '{"name":"alice","age":30}' });
    const result = await executor.execute(
      { input: "{{step1.output}}", expression: "json_extract:.name", outputKey: "result" },
      ctx,
      makeSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe("alice");
    }
  });

  test("applies slice transform", async () => {
    const executor = new TransformStepExecutor();
    const ctx = makeContext({ step1: "hello world" });
    const result = await executor.execute(
      { input: "{{step1.output}}", expression: "slice:0:5", outputKey: "result" },
      ctx,
      makeSignal(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toBe("hello");
    }
  });
});

// ---------------------------------------------------------------------------
// WaitStepExecutor
// ---------------------------------------------------------------------------

describe("WaitStepExecutor", () => {
  test("waits for specified duration", async () => {
    const executor = new WaitStepExecutor();
    const start = Date.now();
    const result = await executor.execute({ durationMs: 50 }, makeContext(), makeSignal());
    const elapsed = Date.now() - start;
    expect(result.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  test("can be aborted during wait", async () => {
    const executor = new WaitStepExecutor();
    const controller = new AbortController();

    setTimeout(() => controller.abort(), 20);
    const result = await executor.execute({ durationMs: 5000 }, makeContext(), controller.signal);
    expect(result.ok).toBe(false);
  });

  test("returns immediately with no duration", async () => {
    const executor = new WaitStepExecutor();
    const result = await executor.execute({}, makeContext(), makeSignal());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ApiStepExecutor
// ---------------------------------------------------------------------------

describe("ApiStepExecutor", () => {
  test("returns error for invalid config", async () => {
    const executor = new ApiStepExecutor();
    const result = await executor.execute({}, makeContext(), makeSignal());
    expect(result.ok).toBe(false);
  });

  test("returns error when aborted", async () => {
    const executor = new ApiStepExecutor();
    const controller = new AbortController();
    controller.abort();
    const result = await executor.execute(
      { url: "http://localhost:9999/test", method: "GET", outputKey: "r" },
      makeContext(),
      controller.signal,
    );
    expect(result.ok).toBe(false);
  });
});
