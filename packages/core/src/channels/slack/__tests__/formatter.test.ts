import { describe, expect, test } from "bun:test";
import { formatForSlack, splitSlackMessage } from "../formatter.ts";

// ---------------------------------------------------------------------------
// formatForSlack
// ---------------------------------------------------------------------------

describe("formatForSlack", () => {
  test("converts bold from **text** to *text*", () => {
    expect(formatForSlack("**bold text**")).toBe("*bold text*");
  });

  test("converts strikethrough from ~~text~~ to ~text~", () => {
    expect(formatForSlack("~~strikethrough~~")).toBe("~strikethrough~");
  });

  test("converts links from [text](url) to <url|text>", () => {
    expect(formatForSlack("[click here](https://example.com)")).toBe("<https://example.com|click here>");
  });

  test("strips language hints from code blocks", () => {
    const input = "```typescript\nconst x = 1;\n```";
    const expected = "```const x = 1;\n```";
    expect(formatForSlack(input)).toBe(expected);
  });

  test("handles mixed formatting", () => {
    const input = "**bold** and ~~strike~~ with [link](https://x.com)";
    const expected = "*bold* and ~strike~ with <https://x.com|link>";
    expect(formatForSlack(input)).toBe(expected);
  });

  test("passes plain text through unchanged", () => {
    const plain = "Just some plain text without any formatting.";
    expect(formatForSlack(plain)).toBe(plain);
  });

  test("preserves inline code unchanged", () => {
    expect(formatForSlack("Use `const x = 1` here")).toBe("Use `const x = 1` here");
  });

  test("preserves blockquotes unchanged", () => {
    expect(formatForSlack("> This is a quote")).toBe("> This is a quote");
  });

  test("handles empty string", () => {
    expect(formatForSlack("")).toBe("");
  });

  test("does not convert bold inside inline code", () => {
    const input = "Text `**not bold**` more text";
    expect(formatForSlack(input)).toBe("Text `**not bold**` more text");
  });
});

// ---------------------------------------------------------------------------
// splitSlackMessage
// ---------------------------------------------------------------------------

describe("splitSlackMessage", () => {
  test("returns single-element array for short messages", () => {
    const result = splitSlackMessage("Hello, world!");
    expect(result).toEqual(["Hello, world!"]);
  });

  test("splits at paragraph boundary", () => {
    const part1 = "A".repeat(100);
    const part2 = "B".repeat(100);
    const text = `${part1}\n\n${part2}`;
    const result = splitSlackMessage(text, 150);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(part1);
    expect(result[1]).toBe(part2);
  });

  test("splits at line boundary when no paragraph break fits", () => {
    const line1 = "A".repeat(80);
    const line2 = "B".repeat(80);
    const text = `${line1}\n${line2}`;
    const result = splitSlackMessage(text, 100);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  test("hard cuts when no natural split point exists", () => {
    const text = "A".repeat(300);
    const result = splitSlackMessage(text, 100);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("A".repeat(100));
    expect(result[1]).toBe("A".repeat(100));
    expect(result[2]).toBe("A".repeat(100));
  });

  test("uses default 4000-character limit", () => {
    const text = "A".repeat(3999);
    const result = splitSlackMessage(text);
    expect(result).toHaveLength(1);
  });

  test("splits at default 4000-character limit", () => {
    const text = "A".repeat(4001);
    const result = splitSlackMessage(text);
    expect(result).toHaveLength(2);
  });

  test("handles empty string", () => {
    const result = splitSlackMessage("");
    expect(result).toEqual([""]);
  });
});
