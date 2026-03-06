import { describe, expect, test } from "bun:test";
import { buildEmailHtml, buildReplySubject, formatEmailResponse, markdownToEmailHtml } from "../formatter.ts";

// ---------------------------------------------------------------------------
// markdownToEmailHtml
// ---------------------------------------------------------------------------

describe("markdownToEmailHtml", () => {
  test("converts headers", () => {
    const html = markdownToEmailHtml("# Title\n## Subtitle");
    expect(html).toContain("<h1");
    expect(html).toContain("Title");
    expect(html).toContain("<h2");
    expect(html).toContain("Subtitle");
  });

  test("converts bold text", () => {
    const html = markdownToEmailHtml("This is **bold** text.");
    expect(html).toContain("<strong>bold</strong>");
  });

  test("converts italic text", () => {
    const html = markdownToEmailHtml("This is *italic* text.");
    expect(html).toContain("<em>italic</em>");
  });

  test("converts inline code", () => {
    const html = markdownToEmailHtml("Use `const x = 1` here.");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1");
  });

  test("converts fenced code blocks", () => {
    const md = "```typescript\nconst x = 1;\n```";
    const html = markdownToEmailHtml(md);
    expect(html).toContain("<pre");
    expect(html).toContain("<code>");
    expect(html).toContain("const x = 1;");
  });

  test("converts unordered lists", () => {
    const md = "- Item 1\n- Item 2\n- Item 3";
    const html = markdownToEmailHtml(md);
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("Item 1");
    expect(html).toContain("Item 3");
  });

  test("converts ordered lists", () => {
    const md = "1. First\n2. Second\n3. Third";
    const html = markdownToEmailHtml(md);
    expect(html).toContain("<ol");
    expect(html).toContain("<li");
    expect(html).toContain("First");
  });

  test("converts links", () => {
    const html = markdownToEmailHtml("[Click here](https://example.com)");
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain("Click here");
  });

  test("converts horizontal rules", () => {
    const html = markdownToEmailHtml("Above\n---\nBelow");
    expect(html).toContain("<hr");
  });

  test("escapes HTML entities in plain text", () => {
    const html = markdownToEmailHtml("A < B & C > D");
    expect(html).toContain("&lt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&gt;");
  });

  test("handles empty input", () => {
    const html = markdownToEmailHtml("");
    expect(html).toBe("");
  });

  test("handles code blocks without closing fence", () => {
    const md = "```\nsome code";
    const html = markdownToEmailHtml(md);
    expect(html).toContain("some code");
    expect(html).toContain("<pre");
  });
});

// ---------------------------------------------------------------------------
// buildEmailHtml
// ---------------------------------------------------------------------------

describe("buildEmailHtml", () => {
  test("wraps body in valid HTML document structure", () => {
    const html = buildEmailHtml("<p>Hello</p>");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<body");
    expect(html).toContain("</body>");
  });

  test("includes the body content", () => {
    const html = buildEmailHtml("<p>Test content</p>");
    expect(html).toContain("<p>Test content</p>");
  });

  test("includes Eidolon footer", () => {
    const html = buildEmailHtml("<p>Content</p>");
    expect(html).toContain("Eidolon");
  });

  test("uses table-based layout for email compatibility", () => {
    const html = buildEmailHtml("<p>Content</p>");
    expect(html).toContain("<table");
  });

  test("includes responsive max-width", () => {
    const html = buildEmailHtml("<p>Content</p>");
    expect(html).toContain("max-width:600px");
  });
});

// ---------------------------------------------------------------------------
// formatEmailResponse
// ---------------------------------------------------------------------------

describe("formatEmailResponse", () => {
  test("returns subject, html, and text parts", () => {
    const result = formatEmailResponse("Hello world", "[Eidolon]");
    expect(result).toHaveProperty("subject");
    expect(result).toHaveProperty("html");
    expect(result).toHaveProperty("text");
  });

  test("includes prefix in subject", () => {
    const result = formatEmailResponse("# My Response\n\nSome details.", "[Eidolon]");
    expect(result.subject).toContain("[Eidolon]");
  });

  test("uses first non-empty line for subject", () => {
    const result = formatEmailResponse("## Important Update\n\nDetails here.", "");
    expect(result.subject).toContain("Important Update");
  });

  test("strips markdown from subject", () => {
    const result = formatEmailResponse("**Bold Title**\n\nText.", "");
    expect(result.subject).not.toContain("**");
    expect(result.subject).toContain("Bold Title");
  });

  test("text part is the original markdown", () => {
    const markdown = "# Title\n\nParagraph with **bold**.";
    const result = formatEmailResponse(markdown, "");
    expect(result.text).toBe(markdown);
  });

  test("html part contains full HTML document", () => {
    const result = formatEmailResponse("Hello", "");
    expect(result.html).toContain("<!DOCTYPE html>");
    expect(result.html).toContain("Hello");
  });

  test("truncates very long subjects", () => {
    const longTitle = "A".repeat(200);
    const result = formatEmailResponse(longTitle, "[Eidolon]");
    expect(result.subject.length).toBeLessThan(200);
  });
});

// ---------------------------------------------------------------------------
// buildReplySubject
// ---------------------------------------------------------------------------

describe("buildReplySubject", () => {
  test("adds Re: prefix to original subject", () => {
    const result = buildReplySubject("Hello", "[Eidolon]");
    expect(result).toBe("[Eidolon] Re: Hello");
  });

  test("does not duplicate Re: prefix", () => {
    const result = buildReplySubject("Re: Hello", "[Eidolon]");
    expect(result).toBe("[Eidolon] Re: Hello");
    expect(result).not.toContain("Re: Re:");
  });

  test("does not duplicate subject prefix", () => {
    const result = buildReplySubject("[Eidolon] Hello", "[Eidolon]");
    expect(result).toBe("[Eidolon] Re: Hello");
  });

  test("handles both Re: and prefix already present", () => {
    const result = buildReplySubject("Re: [Eidolon] Hello", "[Eidolon]");
    expect(result).toBe("[Eidolon] Re: Hello");
  });

  test("works without a prefix", () => {
    const result = buildReplySubject("Original Subject", "");
    expect(result).toBe("Re: Original Subject");
  });

  test("handles empty subject", () => {
    const result = buildReplySubject("", "[Eidolon]");
    expect(result).toBe("[Eidolon] Re: ");
  });

  test("strips multiple Re: prefixes", () => {
    const result = buildReplySubject("Re: Re: Re: Hello", "");
    expect(result).toBe("Re: Hello");
  });
});
