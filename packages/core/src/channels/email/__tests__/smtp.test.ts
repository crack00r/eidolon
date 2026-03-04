import { describe, expect, test } from "bun:test";
import { buildMimeMessage } from "../smtp.ts";

// ---------------------------------------------------------------------------
// buildMimeMessage
// ---------------------------------------------------------------------------

describe("buildMimeMessage", () => {
  test("builds a simple text-only message", () => {
    const { messageId, raw } = buildMimeMessage(
      "sender@example.com",
      ["recipient@example.com"],
      "Test Subject",
      "Hello, world!",
    );

    expect(messageId).toBeTruthy();
    expect(raw).toContain("From: sender@example.com");
    expect(raw).toContain("To: recipient@example.com");
    expect(raw).toContain("Subject: Test Subject");
    expect(raw).toContain("Message-ID:");
    expect(raw).toContain("MIME-Version: 1.0");
    expect(raw).toContain("Content-Type: text/plain; charset=utf-8");
    expect(raw).toContain("Hello, world!");
  });

  test("builds a message with HTML alternative", () => {
    const { raw } = buildMimeMessage(
      "sender@example.com",
      ["recipient@example.com"],
      "HTML Test",
      "Plain text version",
      "<p>HTML version</p>",
    );

    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("text/plain");
    expect(raw).toContain("text/html");
    expect(raw).toContain("Plain text version");
    expect(raw).toContain("<p>HTML version</p>");
  });

  test("includes In-Reply-To header", () => {
    const { raw } = buildMimeMessage(
      "sender@example.com",
      ["recipient@example.com"],
      "Re: Test",
      "Reply body",
      undefined,
      "original-msg-id@example.com",
    );

    expect(raw).toContain("In-Reply-To: <original-msg-id@example.com>");
  });

  test("includes References header", () => {
    const { raw } = buildMimeMessage(
      "sender@example.com",
      ["recipient@example.com"],
      "Re: Test",
      "Reply body",
      undefined,
      "parent@example.com",
      ["root@example.com", "parent@example.com"],
    );

    expect(raw).toContain("References: <root@example.com> <parent@example.com>");
  });

  test("builds a message with attachments", () => {
    const attachmentContent = new Uint8Array([72, 101, 108, 108, 111]);
    const { raw } = buildMimeMessage(
      "sender@example.com",
      ["recipient@example.com"],
      "With Attachment",
      "See attached",
      undefined,
      undefined,
      undefined,
      [
        {
          filename: "test.txt",
          mimeType: "text/plain",
          content: attachmentContent,
        },
      ],
    );

    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain("Content-Disposition: attachment");
    expect(raw).toContain('filename="test.txt"');
    expect(raw).toContain("Content-Transfer-Encoding: base64");
  });

  test("includes multiple recipients", () => {
    const { raw } = buildMimeMessage(
      "sender@example.com",
      ["alice@example.com", "bob@example.com"],
      "Group Email",
      "Hello everyone!",
    );

    expect(raw).toContain("To: alice@example.com, bob@example.com");
  });

  test("generates a unique message ID per call", () => {
    const first = buildMimeMessage("a@b.com", ["c@d.com"], "S", "B");
    const second = buildMimeMessage("a@b.com", ["c@d.com"], "S", "B");

    expect(first.messageId).not.toBe(second.messageId);
  });

  test("message ID ends with @eidolon", () => {
    const { messageId } = buildMimeMessage("a@b.com", ["c@d.com"], "S", "B");
    expect(messageId).toMatch(/@eidolon$/);
  });

  test("includes Date header", () => {
    const { raw } = buildMimeMessage("a@b.com", ["c@d.com"], "S", "B");
    expect(raw).toContain("Date:");
  });

  test("builds message with both HTML and attachments", () => {
    const { raw } = buildMimeMessage(
      "sender@example.com",
      ["recipient@example.com"],
      "Full Featured",
      "Plain text",
      "<p>HTML content</p>",
      undefined,
      undefined,
      [
        {
          filename: "doc.pdf",
          mimeType: "application/pdf",
          content: new Uint8Array([1, 2, 3]),
        },
      ],
    );

    expect(raw).toContain("multipart/mixed");
    expect(raw).toContain("multipart/alternative");
    expect(raw).toContain("text/plain");
    expect(raw).toContain("text/html");
    expect(raw).toContain("application/pdf");
  });
});
