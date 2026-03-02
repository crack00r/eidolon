import { describe, expect, test } from "bun:test";
import { escapeTelegramMarkdown, formatForTelegram, splitMessage } from "../telegram/formatter.ts";

describe("escapeTelegramMarkdown", () => {
  test("escapes special characters", () => {
    const input = "Hello_world! Check [this](url) and use #hashtag.";
    const escaped = escapeTelegramMarkdown(input);

    expect(escaped).toContain("\\!");
    expect(escaped).toContain("\\[");
    expect(escaped).toContain("\\]");
    expect(escaped).toContain("\\(");
    expect(escaped).toContain("\\)");
    expect(escaped).toContain("\\#");
    expect(escaped).toContain("\\.");
    expect(escaped).toContain("\\_");
    // Regular alphanumeric text should be untouched
    expect(escaped).toContain("Hello");
    expect(escaped).toContain("world");
  });
});

describe("formatForTelegram", () => {
  test("converts bold **text** to *text*", () => {
    const result = formatForTelegram("This is **bold** text");
    // Bold should use single asterisks in Telegram
    expect(result).toContain("*bold*");
    // Should NOT contain double asterisks
    expect(result).not.toContain("**");
  });

  test("preserves code blocks", () => {
    const input = "Look at this:\n```typescript\nconst x = 1;\n```\nDone.";
    const result = formatForTelegram(input);

    // Code block content should be preserved as-is
    expect(result).toContain("```typescript\nconst x = 1;\n```");
    // Text outside code blocks should be escaped
    expect(result).toContain("Done\\.");
  });

  test("preserves inline code", () => {
    const input = "Use `console.log()` for debugging.";
    const result = formatForTelegram(input);

    // Inline code should be preserved
    expect(result).toContain("`console.log()`");
    // Period outside code should be escaped
    expect(result).toContain("debugging\\.");
  });

  test("converts strikethrough ~~text~~ to ~text~", () => {
    const result = formatForTelegram("This is ~~removed~~ text");
    expect(result).toContain("~removed~");
    expect(result).not.toContain("~~");
  });
});

describe("splitMessage", () => {
  test("does not split short messages", () => {
    const text = "Hello, world!";
    const chunks = splitMessage(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  test("splits at paragraph boundaries", () => {
    const paragraph1 = "A".repeat(3000);
    const paragraph2 = "B".repeat(2000);
    const text = `${paragraph1}\n\n${paragraph2}`;

    // Total: 3000 + 2 + 2000 = 5002, exceeds 4096
    const chunks = splitMessage(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(paragraph1);
    expect(chunks[1]).toBe(paragraph2);
  });

  test("handles messages without good split points", () => {
    // Single long line with no paragraph or line breaks
    const text = "X".repeat(5000);
    const chunks = splitMessage(text, 4096);

    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(4096);
    expect(chunks[1]).toHaveLength(904);
  });

  test("splits at line boundaries when no paragraph boundary", () => {
    const line1 = "A".repeat(3000);
    const line2 = "B".repeat(2000);
    const text = `${line1}\n${line2}`;

    const chunks = splitMessage(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(line1);
    expect(chunks[1]).toBe(line2);
  });
});
