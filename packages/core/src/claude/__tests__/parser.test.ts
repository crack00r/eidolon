import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseStreamLine, parseStreamOutput } from "../parser.ts";

describe("parseStreamLine", () => {
  test("parses assistant text message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { type: "text", text: "Hello world" },
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("text");
    expect(event?.content).toBe("Hello world");
    expect(typeof event?.timestamp).toBe("number");
  });

  test("parses tool_use message", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { type: "tool_use", name: "Read", input: { path: "/tmp/file" } },
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("tool_use");
    expect(event?.toolName).toBe("Read");
    expect(event?.toolInput).toEqual({ path: "/tmp/file" });
  });

  test("parses tool_result with tool_use_id", () => {
    const line = JSON.stringify({
      type: "result",
      result: "file contents here",
      tool_use_id: "tool_123",
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("tool_result");
    expect(event?.toolResult).toBe("file contents here");
  });

  test("parses final result without tool_use_id as text", () => {
    const line = JSON.stringify({
      type: "result",
      result: "Final answer",
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("text");
    expect(event?.content).toBe("Final answer");
  });

  test("parses error message", () => {
    const line = JSON.stringify({
      type: "error",
      error: "Rate limit exceeded",
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("error");
    expect(event?.error).toBe("Rate limit exceeded");
  });

  test("parses error message with message field fallback", () => {
    const line = JSON.stringify({
      type: "error",
      message: "Something went wrong",
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("error");
    expect(event?.error).toBe("Something went wrong");
  });

  test("parses system message", () => {
    const line = JSON.stringify({
      type: "system",
      message: "Session started",
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("system");
    expect(event?.content).toBe("Session started");
  });

  test("returns null for empty lines", () => {
    expect(parseStreamLine("")).toBeNull();
    expect(parseStreamLine("   ")).toBeNull();
    expect(parseStreamLine("\n")).toBeNull();
  });

  test("returns null for invalid JSON and logs warning", () => {
    const warnSpy = mock((..._args: unknown[]) => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      expect(parseStreamLine("not json")).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain("not json");

      expect(parseStreamLine("{broken")).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(String(warnSpy.mock.calls[1]![0])).toContain("{broken");
    } finally {
      console.warn = originalWarn;
    }
  });

  test("truncates long invalid JSON lines in warning", () => {
    const warnSpy = mock((..._args: unknown[]) => {});
    const originalWarn = console.warn;
    console.warn = warnSpy;

    try {
      const longLine = "x".repeat(300);
      expect(parseStreamLine(longLine)).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnMessage = String(warnSpy.mock.calls[0]![0]);
      expect(warnMessage).toContain("...");
      expect(warnMessage.length).toBeLessThan(300);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("returns null for non-object JSON values", () => {
    expect(parseStreamLine('"just a string"')).toBeNull();
    expect(parseStreamLine("42")).toBeNull();
    expect(parseStreamLine("null")).toBeNull();
  });

  test("returns system event for unknown type", () => {
    const line = JSON.stringify({ type: "unknown_type", data: 123 });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("system");
    expect(event?.content).toContain("unknown_type");
  });

  test("returns null for assistant message without message field", () => {
    const line = JSON.stringify({ type: "assistant" });
    expect(parseStreamLine(line)).toBeNull();
  });

  test("handles tool_use with non-object input", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { type: "tool_use", name: "Run", input: "not an object" },
    });
    const event = parseStreamLine(line);
    expect(event).not.toBeNull();
    expect(event?.type).toBe("tool_use");
    expect(event?.toolInput).toEqual({});
  });
});

describe("parseStreamOutput", () => {
  test("handles multiple lines of output", () => {
    const output = [
      JSON.stringify({ type: "system", message: "Session started" }),
      JSON.stringify({ type: "assistant", message: { type: "text", text: "Hello" } }),
      "",
      JSON.stringify({ type: "result", result: "Done" }),
    ].join("\n");

    const events = parseStreamOutput(output);
    expect(events).toHaveLength(3);
    expect(events[0]?.type).toBe("system");
    expect(events[1]?.type).toBe("text");
    expect(events[2]?.type).toBe("text");
  });

  test("returns empty array for empty input", () => {
    expect(parseStreamOutput("")).toHaveLength(0);
  });

  test("skips invalid lines in mixed output", () => {
    const output = ["not json", JSON.stringify({ type: "system", message: "ok" }), "also not json"].join("\n");

    const events = parseStreamOutput(output);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("system");
  });
});
