import { describe, expect, test } from "bun:test";
import { formatAsEmbed, formatForDiscord, splitDiscordMessage } from "../formatter.ts";

// ---------------------------------------------------------------------------
// formatForDiscord
// ---------------------------------------------------------------------------

describe("formatForDiscord", () => {
  test("passes standard markdown through unchanged", () => {
    const md = "**bold** _italic_ ~~strike~~ `code`";
    expect(formatForDiscord(md)).toBe(md);
  });

  test("preserves code blocks", () => {
    const md = "```ts\nconst x = 1;\n```";
    expect(formatForDiscord(md)).toBe(md);
  });

  test("handles empty string", () => {
    expect(formatForDiscord("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// formatAsEmbed
// ---------------------------------------------------------------------------

describe("formatAsEmbed", () => {
  test("formats title and description", () => {
    const result = formatAsEmbed("Title", "Some description");
    expect(result).toBe("**Title**\nSome description");
  });

  test("formats with fields", () => {
    const result = formatAsEmbed("Status", "All systems go", [
      { name: "Uptime", value: "3 days" },
      { name: "Memory", value: "128 MB" },
    ]);
    expect(result).toContain("**Status**");
    expect(result).toContain("**Uptime:** 3 days");
    expect(result).toContain("**Memory:** 128 MB");
  });

  test("handles empty description", () => {
    const result = formatAsEmbed("Title", "");
    expect(result).toBe("**Title**");
  });

  test("handles empty fields array", () => {
    const result = formatAsEmbed("Title", "Desc", []);
    expect(result).toBe("**Title**\nDesc");
  });
});

// ---------------------------------------------------------------------------
// splitDiscordMessage
// ---------------------------------------------------------------------------

describe("splitDiscordMessage", () => {
  test("returns single-element array for short messages", () => {
    const result = splitDiscordMessage("Hello, world!");
    expect(result).toEqual(["Hello, world!"]);
  });

  test("splits at paragraph boundary", () => {
    const part1 = "A".repeat(100);
    const part2 = "B".repeat(100);
    const text = `${part1}\n\n${part2}`;
    const result = splitDiscordMessage(text, 150);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(part1);
    expect(result[1]).toBe(part2);
  });

  test("splits at line boundary when no paragraph break fits", () => {
    const line1 = "A".repeat(80);
    const line2 = "B".repeat(80);
    const text = `${line1}\n${line2}`;
    const result = splitDiscordMessage(text, 100);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  test("hard cuts when no natural split point exists", () => {
    const text = "A".repeat(300);
    const result = splitDiscordMessage(text, 100);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe("A".repeat(100));
    expect(result[1]).toBe("A".repeat(100));
    expect(result[2]).toBe("A".repeat(100));
  });

  test("uses default 2000-character limit", () => {
    const text = "A".repeat(1999);
    const result = splitDiscordMessage(text);
    expect(result).toHaveLength(1);
  });

  test("handles empty string", () => {
    const result = splitDiscordMessage("");
    expect(result).toEqual([""]);
  });
});
