import { describe, expect, test } from "bun:test";
import { formatForWhatsApp, splitWhatsAppMessage } from "../formatter.ts";

// ---------------------------------------------------------------------------
// formatForWhatsApp
// ---------------------------------------------------------------------------

describe("formatForWhatsApp", () => {
  test("converts bold **text** to *text*", () => {
    expect(formatForWhatsApp("This is **bold** text")).toBe("This is *bold* text");
  });

  test("preserves italic _text_", () => {
    expect(formatForWhatsApp("This is _italic_ text")).toBe("This is _italic_ text");
  });

  test("converts strikethrough ~~text~~ to ~text~", () => {
    expect(formatForWhatsApp("This is ~~deleted~~ text")).toBe("This is ~deleted~ text");
  });

  test("converts headers to bold", () => {
    expect(formatForWhatsApp("# Main Title")).toBe("*Main Title*");
    expect(formatForWhatsApp("## Sub Title")).toBe("*Sub Title*");
    expect(formatForWhatsApp("### Third Level")).toBe("*Third Level*");
  });

  test("preserves fenced code blocks", () => {
    const input = "Before\n```ts\nconst x = 1;\n```\nAfter";
    const result = formatForWhatsApp(input);
    expect(result).toContain("```const x = 1;\n```");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  test("preserves inline code", () => {
    const input = "Use `bun test` to run tests";
    expect(formatForWhatsApp(input)).toBe("Use `bun test` to run tests");
  });

  test("handles bold+italic ***text*** -> *_text_*", () => {
    expect(formatForWhatsApp("This is ***important***")).toBe("This is *_important_*");
  });

  test("handles plain text with no markdown", () => {
    const input = "Just plain text, nothing special.";
    expect(formatForWhatsApp(input)).toBe(input);
  });

  test("does not mangle mixed formatting", () => {
    const input = "**Bold** and _italic_ and ~~strike~~";
    expect(formatForWhatsApp(input)).toBe("*Bold* and _italic_ and ~strike~");
  });
});

// ---------------------------------------------------------------------------
// splitWhatsAppMessage
// ---------------------------------------------------------------------------

describe("splitWhatsAppMessage", () => {
  test("returns single chunk for short messages", () => {
    const chunks = splitWhatsAppMessage("Hello!");
    expect(chunks).toEqual(["Hello!"]);
  });

  test("returns single chunk for messages at exactly the limit", () => {
    const text = "A".repeat(4096);
    const chunks = splitWhatsAppMessage(text);
    expect(chunks).toEqual([text]);
  });

  test("splits at paragraph boundaries", () => {
    const para1 = "A".repeat(2000);
    const para2 = "B".repeat(2000);
    const para3 = "C".repeat(2000);
    const text = `${para1}\n\n${para2}\n\n${para3}`;

    const chunks = splitWhatsAppMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk should be <= 4096 characters
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  test("splits at line boundaries when paragraph split is not possible", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"x".repeat(30)}`);
    const text = lines.join("\n");

    const chunks = splitWhatsAppMessage(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });

  test("hard cuts when no boundary is found", () => {
    // One huge unbroken string
    const text = "A".repeat(8192);
    const chunks = splitWhatsAppMessage(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.length).toBe(4096);
    expect(chunks[1]?.length).toBe(4096);
  });

  test("filters out empty chunks", () => {
    const chunks = splitWhatsAppMessage("A".repeat(4000) + "\n\n" + "B".repeat(100));
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  test("respects custom maxLength parameter", () => {
    const text = "Hello World\n\nSecond paragraph";
    const chunks = splitWhatsAppMessage(text, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(15);
    }
  });
});
