import { describe, expect, test } from "bun:test";
import { isErr, isOk } from "@eidolon/protocol";
import { FakeClaudeProcess } from "../fake-claude-process.ts";
import { collectAsync } from "../test-helpers.ts";

describe("FakeClaudeProcess", () => {
  test("withResponse returns text events for matching prompts", async () => {
    const fake = FakeClaudeProcess.withResponse("hello", "Hi there!");
    const events = await collectAsync(fake.run("hello world", { workspaceDir: "/tmp/test" }));

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("text");
    expect(events[0]?.content).toBe("Hi there!");
    expect(events[1]?.type).toBe("done");
    expect(fake.getCallCount()).toBe(1);
    expect(fake.getLastPrompt()).toBe("hello world");
  });

  test("withToolUse simulates tool usage", async () => {
    const fake = FakeClaudeProcess.withToolUse("Read", { path: "/tmp" }, "file contents");
    const events = await collectAsync(fake.run("read the file", { workspaceDir: "/tmp" }));

    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("tool_use");
    expect(events[0]?.toolName).toBe("Read");
    expect(events[1]?.type).toBe("tool_result");
    expect(events[1]?.toolResult).toBe("file contents");
    expect(events[2]?.type).toBe("done");
  });

  test("withError returns error events", async () => {
    const fake = FakeClaudeProcess.withError("CLAUDE_TIMEOUT", "Request timed out");
    const events = await collectAsync(fake.run("anything", { workspaceDir: "/tmp" }));

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect(events[0]?.error).toBe("Request timed out");
  });

  test("unavailable returns false for isAvailable", async () => {
    const fake = FakeClaudeProcess.unavailable();
    expect(await fake.isAvailable()).toBe(false);

    const version = await fake.getVersion();
    expect(isErr(version)).toBe(true);
  });

  test("available returns version", async () => {
    const fake = FakeClaudeProcess.withResponse("test", "ok");
    expect(await fake.isAvailable()).toBe(true);

    const version = await fake.getVersion();
    expect(isOk(version)).toBe(true);
  });

  test("tracks multiple calls", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "response");
    await collectAsync(fake.run("first", { workspaceDir: "/tmp" }));
    await collectAsync(fake.run("second", { workspaceDir: "/tmp" }));

    expect(fake.getCallCount()).toBe(2);
    expect(fake.getCalls()).toHaveLength(2);
    expect(fake.getCalls()[0]?.prompt).toBe("first");
    expect(fake.getCalls()[1]?.prompt).toBe("second");

    fake.reset();
    expect(fake.getCallCount()).toBe(0);
  });

  test("default response for unmatched prompts", async () => {
    const fake = FakeClaudeProcess.withResponse("specific", "matched");
    const events = await collectAsync(fake.run("different prompt", { workspaceDir: "/tmp" }));

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("text");
    expect(events[0]?.content).toContain("[FakeClaudeProcess]");
    expect(events[1]?.type).toBe("done");
  });

  test("abort is a no-op", async () => {
    const fake = new FakeClaudeProcess();
    await fake.abort("session-123");
    // Should not throw
  });

  test("getLastOptions returns session options", async () => {
    const fake = FakeClaudeProcess.withResponse(/./, "ok");
    const opts = { workspaceDir: "/tmp", model: "test-model", maxTurns: 5 };
    await collectAsync(fake.run("prompt", opts));

    expect(fake.getLastOptions()).toEqual(opts);
  });
});
