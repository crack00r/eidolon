import { describe, expect, test } from "bun:test";
import type { ClaudeSessionOptions } from "@eidolon/protocol";
import { z } from "zod";
import { buildClaudeArgs } from "../args.ts";

function makeOptions(overrides: Partial<ClaudeSessionOptions> = {}): ClaudeSessionOptions {
  return {
    workspaceDir: "/tmp/workspace",
    ...overrides,
  };
}

describe("buildClaudeArgs", () => {
  test("basic prompt produces correct base args", () => {
    const args = buildClaudeArgs("Hello", makeOptions());
    expect(args).toEqual(["--print", "--output-format", "stream-json", "--verbose", "--", "Hello"]);
  });

  test("prompt is always the last argument after -- separator", () => {
    const args = buildClaudeArgs("my prompt", makeOptions({ model: "opus" }));
    expect(args[args.length - 1]).toBe("my prompt");
    expect(args[args.length - 2]).toBe("--");
  });

  test("does not pass sessionId to CLI (used for internal tracking only)", () => {
    const args = buildClaudeArgs("prompt", makeOptions({ sessionId: "sess-1" }));
    expect(args).not.toContain("--session-id");
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
    expect(args).not.toContain("--session-id");
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

  test("adds schema instruction to system prompt when outputSchema is provided", () => {
    const schema = z.object({ name: z.string(), score: z.number() });
    const args = buildClaudeArgs("prompt", makeOptions({ outputSchema: schema }));
    expect(args).toContain("--system-prompt");
    const systemPromptIdx = args.indexOf("--system-prompt");
    const systemPrompt = args[systemPromptIdx + 1];
    expect(systemPrompt).toContain("You MUST respond with ONLY valid JSON");
    expect(systemPrompt).toContain('"type": "object"');
  });

  test("appends schema instruction to existing system prompt", () => {
    const schema = z.object({ value: z.string() });
    const args = buildClaudeArgs(
      "prompt",
      makeOptions({
        systemPrompt: "Be concise.",
        outputSchema: schema,
      }),
    );
    const systemPromptIdx = args.indexOf("--system-prompt");
    const systemPrompt = args[systemPromptIdx + 1];
    expect(systemPrompt).toContain("Be concise.");
    expect(systemPrompt).toContain("You MUST respond with ONLY valid JSON");
  });

  test("does not add schema instruction when outputSchema is absent", () => {
    const args = buildClaudeArgs("prompt", makeOptions());
    expect(args).not.toContain("--system-prompt");
  });

  describe("resume mode", () => {
    test("uses --resume with session ID instead of fresh session flags", () => {
      const args = buildClaudeArgs(
        "follow up",
        makeOptions({
          resumeSessionId: "abc-123-def",
          model: "opus",
          allowedTools: ["Read", "Write"],
          systemPrompt: "Be helpful.",
        }),
      );

      expect(args).toContain("--resume");
      expect(args[args.indexOf("--resume") + 1]).toBe("abc-123-def");
      expect(args).toContain("--print");
      expect(args).toContain("--output-format");
      expect(args).toContain("--verbose");
      expect(args[args.length - 1]).toBe("follow up");
      expect(args[args.length - 2]).toBe("--");
    });

    test("omits model, allowedTools, systemPrompt, mcpConfig in resume mode", () => {
      const args = buildClaudeArgs(
        "prompt",
        makeOptions({
          resumeSessionId: "sess-xyz",
          model: "opus",
          allowedTools: ["Read"],
          systemPrompt: "Be concise.",
          mcpConfig: "/mcp.json",
        }),
      );

      expect(args).not.toContain("--model");
      expect(args).not.toContain("--allowedTools");
      expect(args).not.toContain("--system-prompt");
      expect(args).not.toContain("--mcp-config");
    });

    test("still includes --max-turns in resume mode", () => {
      const args = buildClaudeArgs(
        "prompt",
        makeOptions({
          resumeSessionId: "sess-xyz",
          maxTurns: 3,
        }),
      );

      expect(args).toContain("--max-turns");
      expect(args[args.indexOf("--max-turns") + 1]).toBe("3");
    });

    test("does not use --resume when resumeSessionId is not provided", () => {
      const args = buildClaudeArgs("prompt", makeOptions());
      expect(args).not.toContain("--resume");
    });

    test("resume mode produces correct full arg list", () => {
      const args = buildClaudeArgs(
        "next question",
        makeOptions({ resumeSessionId: "uuid-here", maxTurns: 5 }),
      );

      expect(args).toEqual([
        "--print",
        "--output-format",
        "stream-json",
        "--verbose",
        "--resume",
        "uuid-here",
        "--max-turns",
        "5",
        "--",
        "next question",
      ]);
    });
  });
});
