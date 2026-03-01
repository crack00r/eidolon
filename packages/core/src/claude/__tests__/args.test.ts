import { describe, expect, test } from "bun:test";
import type { ClaudeSessionOptions } from "@eidolon/protocol";
import { buildClaudeArgs } from "../args.js";

function makeOptions(overrides: Partial<ClaudeSessionOptions> = {}): ClaudeSessionOptions {
  return {
    workspaceDir: "/tmp/workspace",
    ...overrides,
  };
}

describe("buildClaudeArgs", () => {
  test("basic prompt produces correct base args", () => {
    const args = buildClaudeArgs("Hello", makeOptions());
    expect(args).toEqual(["--print", "--output-format", "stream-json", "Hello"]);
  });

  test("prompt is always the last argument", () => {
    const args = buildClaudeArgs("my prompt", makeOptions({ model: "opus" }));
    expect(args[args.length - 1]).toBe("my prompt");
  });

  test("adds --session-id flag", () => {
    const args = buildClaudeArgs("prompt", makeOptions({ sessionId: "sess-1" }));
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe("sess-1");
  });

  test("adds --model flag", () => {
    const args = buildClaudeArgs("prompt", makeOptions({ model: "claude-sonnet-4-20250514" }));
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-20250514");
  });

  test("adds --allowedTools with comma-separated list", () => {
    const args = buildClaudeArgs("prompt", makeOptions({ allowedTools: ["Read", "Write", "Bash"] }));
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Write,Bash");
  });

  test("omits --allowedTools when array is empty", () => {
    const args = buildClaudeArgs("prompt", makeOptions({ allowedTools: [] }));
    expect(args).not.toContain("--allowedTools");
  });

  test("adds --mcp-config flag", () => {
    const args = buildClaudeArgs("prompt", makeOptions({ mcpConfig: "/path/to/mcp.json" }));
    expect(args).toContain("--mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/path/to/mcp.json");
  });

  test("adds --max-turns flag", () => {
    const args = buildClaudeArgs("prompt", makeOptions({ maxTurns: 5 }));
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("5");
  });

  test("adds --system-prompt flag", () => {
    const args = buildClaudeArgs("prompt", makeOptions({ systemPrompt: "You are helpful." }));
    expect(args).toContain("--system-prompt");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("You are helpful.");
  });

  test("combines all options correctly", () => {
    const args = buildClaudeArgs(
      "do the thing",
      makeOptions({
        sessionId: "s-42",
        model: "opus",
        allowedTools: ["Read"],
        mcpConfig: "/mcp.json",
        maxTurns: 10,
        systemPrompt: "Be concise.",
      }),
    );

    expect(args[0]).toBe("--print");
    expect(args[1]).toBe("--output-format");
    expect(args[2]).toBe("stream-json");
    expect(args).toContain("--session-id");
    expect(args).toContain("--model");
    expect(args).toContain("--allowedTools");
    expect(args).toContain("--mcp-config");
    expect(args).toContain("--max-turns");
    expect(args).toContain("--system-prompt");
    expect(args[args.length - 1]).toBe("do the thing");
  });

  test("omits optional flags when not provided", () => {
    const args = buildClaudeArgs("prompt", makeOptions());
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--allowedTools");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--system-prompt");
  });
});
