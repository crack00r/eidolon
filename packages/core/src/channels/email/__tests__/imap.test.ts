import { describe, expect, test } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import type { IImapClient, ImapMessage } from "../imap.ts";

// ---------------------------------------------------------------------------
// FakeImapClient for interface validation
// ---------------------------------------------------------------------------

/**
 * A fake IMAP client that validates the IImapClient interface contract.
 * This also serves as a reference implementation for test doubles.
 */
class FakeImapClient implements IImapClient {
  private connected = false;
  private messages: ImapMessage[] = [];
  private readUids: Set<number> = new Set();

  /** Configure messages to return on fetchNewMessages. */
  setMessages(messages: ImapMessage[]): void {
    this.messages = messages;
  }

  async connect(): Promise<Result<void, EidolonError>> {
    this.connected = true;
    return Ok(undefined);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async fetchNewMessages(): Promise<Result<readonly ImapMessage[], EidolonError>> {
    // Return only messages that haven't been marked as read
    const unread = this.messages.filter((m) => !this.readUids.has(m.uid));
    return Ok(unread);
  }

  async markAsRead(uid: number): Promise<Result<void, EidolonError>> {
    this.readUids.add(uid);
    return Ok(undefined);
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Expose read UIDs for test assertions. */
  getReadUids(): ReadonlySet<number> {
    return this.readUids;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FakeImapClient (interface validation)", () => {
  test("starts disconnected", () => {
    const client = new FakeImapClient();
    expect(client.isConnected()).toBe(false);
  });

  test("connect sets connected state", async () => {
    const client = new FakeImapClient();
    const result = await client.connect();
    expect(result.ok).toBe(true);
    expect(client.isConnected()).toBe(true);
  });

  test("disconnect clears connected state", async () => {
    const client = new FakeImapClient();
    await client.connect();
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  test("fetchNewMessages returns configured messages", async () => {
    const client = new FakeImapClient();
    await client.connect();

    const testMessages: ImapMessage[] = [
      {
        uid: 1,
        messageId: "msg-001@test.com",
        from: "alice@test.com",
        to: ["eidolon@test.com"],
        subject: "Hello",
        date: new Date("2026-01-01"),
        textBody: "Hello body",
        attachments: [],
      },
      {
        uid: 2,
        messageId: "msg-002@test.com",
        from: "bob@test.com",
        to: ["eidolon@test.com"],
        subject: "World",
        date: new Date("2026-01-02"),
        textBody: "World body",
        attachments: [],
      },
    ];

    client.setMessages(testMessages);
    const result = await client.fetchNewMessages();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      expect(result.value[0]?.messageId).toBe("msg-001@test.com");
      expect(result.value[1]?.from).toBe("bob@test.com");
    }
  });

  test("fetchNewMessages excludes messages marked as read", async () => {
    const client = new FakeImapClient();
    await client.connect();

    client.setMessages([
      {
        uid: 1,
        messageId: "msg-001@test.com",
        from: "alice@test.com",
        to: ["eidolon@test.com"],
        subject: "Read this",
        date: new Date(),
        textBody: "Content",
        attachments: [],
      },
      {
        uid: 2,
        messageId: "msg-002@test.com",
        from: "bob@test.com",
        to: ["eidolon@test.com"],
        subject: "And this",
        date: new Date(),
        textBody: "Content 2",
        attachments: [],
      },
    ]);

    // Mark first message as read
    await client.markAsRead(1);

    const result = await client.fetchNewMessages();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.uid).toBe(2);
    }
  });

  test("markAsRead records the UID", async () => {
    const client = new FakeImapClient();
    await client.connect();

    await client.markAsRead(42);
    await client.markAsRead(99);

    expect(client.getReadUids().has(42)).toBe(true);
    expect(client.getReadUids().has(99)).toBe(true);
    expect(client.getReadUids().has(1)).toBe(false);
  });

  test("returns empty array when no messages", async () => {
    const client = new FakeImapClient();
    await client.connect();

    const result = await client.fetchNewMessages();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(0);
    }
  });

  test("ImapMessage supports all fields", () => {
    const message: ImapMessage = {
      uid: 1,
      messageId: "test@example.com",
      from: "sender@example.com",
      to: ["recipient@example.com"],
      subject: "Full featured",
      date: new Date(),
      textBody: "Plain text",
      htmlBody: "<p>HTML</p>",
      inReplyTo: "parent@example.com",
      references: ["root@example.com", "parent@example.com"],
      attachments: [
        {
          filename: "test.pdf",
          mimeType: "application/pdf",
          size: 1024,
          content: new Uint8Array(1024),
        },
      ],
    };

    expect(message.uid).toBe(1);
    expect(message.htmlBody).toBe("<p>HTML</p>");
    expect(message.inReplyTo).toBe("parent@example.com");
    expect(message.references?.length).toBe(2);
    expect(message.attachments.length).toBe(1);
    expect(message.attachments[0]?.size).toBe(1024);
  });
});
