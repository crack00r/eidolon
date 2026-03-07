import { beforeEach, describe, expect, test } from "bun:test";
import type { InboundMessage } from "@eidolon/protocol";
import type { Logger } from "../../../logging/logger.ts";
import type { ISlackClient, SlackConfig, SlackInboundEvent, SlackMessage } from "../channel.ts";
import { SlackChannel } from "../channel.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

/**
 * FakeSlackClient implements ISlackClient for testing.
 * Records all postMessage/addReaction calls and allows simulating events.
 */
class FakeSlackClient implements ISlackClient {
  private started = false;
  private eventHandlers: Array<(event: SlackInboundEvent) => Promise<void>> = [];
  readonly sentMessages: Array<{ channel: string; text: string; threadTs?: string }> = [];
  readonly addedReactions: Array<{ channel: string; ts: string; emoji: string }> = [];
  private messageCounter = 0;
  startCallCount = 0;
  stopCallCount = 0;
  shouldFailStart = false;
  shouldFailSend = false;
  sendFailMessage = "send failed";

  async start(): Promise<void> {
    this.startCallCount++;
    if (this.shouldFailStart) {
      throw new Error("Failed to start: invalid token");
    }
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopCallCount++;
    this.started = false;
  }

  onEvent(handler: (event: SlackInboundEvent) => Promise<void>): void {
    this.eventHandlers.push(handler);
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<SlackMessage> {
    if (this.shouldFailSend) {
      throw new Error(this.sendFailMessage);
    }
    this.messageCounter++;
    const msg: SlackMessage = {
      ts: `ts-${this.messageCounter}`,
      channel,
      text,
      threadTs,
    };
    this.sentMessages.push({ channel, text, threadTs });
    return msg;
  }

  async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    this.addedReactions.push({ channel, ts, emoji });
  }

  async downloadFile(_url: string): Promise<Uint8Array> {
    return new Uint8Array([0x50, 0x4b]); // minimal test data
  }

  isConnected(): boolean {
    return this.started;
  }

  /** Simulate an incoming event for testing. */
  async simulateEvent(event: SlackInboundEvent): Promise<void> {
    for (const handler of this.eventHandlers) {
      await handler(event);
    }
  }
}

function createTestConfig(overrides?: Partial<SlackConfig>): SlackConfig {
  return {
    botToken: "xoxb-test-token",
    appToken: "xapp-test-token",
    signingSecret: "test-signing-secret",
    socketMode: true,
    allowedUserIds: ["U01USER1", "U01USER2"],
    allowedChannelIds: [],
    respondInThread: true,
    ...overrides,
  };
}

function createInboundEvent(overrides?: Partial<SlackInboundEvent>): SlackInboundEvent {
  return {
    type: "message",
    ts: "1234567890.123456",
    channel: "C01CHANNEL",
    user: { id: "U01USER1", username: "testuser", isBot: false },
    text: "Hello, Eidolon!",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SlackChannel", () => {
  let client: FakeSlackClient;
  let logger: Logger;

  beforeEach(() => {
    client = new FakeSlackClient();
    logger = createSilentLogger();
  });

  // -- Connection lifecycle ---------------------------------------------------

  describe("connect/disconnect", () => {
    test("connects successfully", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const result = await channel.connect();
      expect(result.ok).toBe(true);
      expect(channel.isConnected()).toBe(true);
      expect(client.startCallCount).toBe(1);
    });

    test("double-connect is idempotent", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      await channel.connect();
      const result = await channel.connect();
      expect(result.ok).toBe(true);
      expect(client.startCallCount).toBe(1);
    });

    test("returns Err on start failure", async () => {
      client.shouldFailStart = true;
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const result = await channel.connect();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CHANNEL_AUTH_FAILED");
      }
      expect(channel.isConnected()).toBe(false);
    });

    test("disconnects gracefully", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(client.stopCallCount).toBe(1);
    });

    test("disconnect is a no-op when not connected", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      await channel.disconnect();
      expect(client.stopCallCount).toBe(0);
    });
  });

  // -- Channel properties -----------------------------------------------------

  describe("properties", () => {
    test("has correct id and name", () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      expect(channel.id).toBe("slack");
      expect(channel.name).toBe("Slack");
    });

    test("reports correct capabilities", () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      expect(channel.capabilities.text).toBe(true);
      expect(channel.capabilities.markdown).toBe(true);
      expect(channel.capabilities.images).toBe(true);
      expect(channel.capabilities.documents).toBe(true);
      expect(channel.capabilities.voice).toBe(false);
      expect(channel.capabilities.reactions).toBe(true);
      expect(channel.capabilities.editing).toBe(false);
      expect(channel.capabilities.streaming).toBe(false);
    });
  });

  // -- Inbound messages -------------------------------------------------------

  describe("inbound messages", () => {
    test("routes authorized text message to handler", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateEvent(createInboundEvent());

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe("Hello, Eidolon!");
      expect(received[0]?.userId).toBe("U01USER1");
      expect(received[0]?.id).toMatch(/^sl-1234567890\.123456-/);
    });

    test("sets replyToId from threadTs", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateEvent(createInboundEvent({ threadTs: "1234567890.000000" }));

      expect(received).toHaveLength(1);
      expect(received[0]?.replyToId).toBe("1234567890.000000");
    });

    test("rejects messages from unauthorized users", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateEvent(
        createInboundEvent({
          user: { id: "U99HACKER", username: "hacker", isBot: false },
        }),
      );

      expect(received).toHaveLength(0);
    });

    test("rejects messages from unauthorized channel", async () => {
      const channel = new SlackChannel(createTestConfig({ allowedChannelIds: ["C01ALLOWED"] }), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateEvent(createInboundEvent({ channel: "C99NOTALLOWED" }));

      expect(received).toHaveLength(0);
    });

    test("accepts messages when allowedChannelIds is empty (all allowed)", async () => {
      const channel = new SlackChannel(createTestConfig({ allowedChannelIds: [] }), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateEvent(createInboundEvent({ channel: "C99ANYCHANNEL" }));

      expect(received).toHaveLength(1);
    });

    test("ignores bot messages", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateEvent(
        createInboundEvent({
          user: { id: "U01USER1", username: "botuser", isBot: true },
        }),
      );

      expect(received).toHaveLength(0);
    });

    test("truncates excessively long inbound text", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      const longText = "A".repeat(200_000);
      await client.simulateEvent(createInboundEvent({ text: longText }));

      expect(received).toHaveLength(1);
      expect(received[0]?.text?.length).toBe(100_000);
    });

    test("handles slash command as inbound message", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateEvent(
        createInboundEvent({
          type: "slash_command",
          text: "what is the weather?",
          commandName: "/eidolon",
          responseUrl: "https://hooks.slack.com/commands/resp",
        }),
      );

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe("what is the weather?");
    });

    test("handles app_mention as inbound message", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateEvent(
        createInboundEvent({
          type: "app_mention",
          text: "<@U01BOT> do something",
        }),
      );

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe("<@U01BOT> do something");
    });

    test("converts file attachments", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateEvent(
        createInboundEvent({
          files: [
            {
              id: "F01FILE",
              name: "screenshot.png",
              mimetype: "image/png",
              size: 2048,
              urlPrivateDownload: "https://files.slack.com/screenshot.png",
            },
          ],
        }),
      );

      expect(received).toHaveLength(1);
      expect(received[0]?.attachments).toHaveLength(1);
      expect(received[0]?.attachments?.[0]?.type).toBe("image");
      expect(received[0]?.attachments?.[0]?.mimeType).toBe("image/png");
      expect(received[0]?.attachments?.[0]?.filename).toBe("screenshot.png");
    });

    test("drops no-handler messages gracefully", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      await channel.connect();
      // No handler registered -- should not throw
      await client.simulateEvent(createInboundEvent());
    });
  });

  // -- Rate limiting ----------------------------------------------------------

  describe("rate limiting", () => {
    test("rate limits after 30 messages in 60 seconds", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      for (let i = 0; i < 31; i++) {
        await client.simulateEvent(createInboundEvent({ ts: `ts-${i}` }));
      }

      expect(received).toHaveLength(30);
    });
  });

  // -- Outbound messages ------------------------------------------------------

  describe("send", () => {
    test("sends text message to channel", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      await channel.connect();

      const result = await channel.send({
        id: "out-1",
        channelId: "C01CHANNEL",
        text: "Hello from Eidolon!",
      });

      expect(result.ok).toBe(true);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toBe("Hello from Eidolon!");
      expect(client.sentMessages[0]?.channel).toBe("C01CHANNEL");
    });

    test("converts markdown to mrkdwn before sending", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      await channel.connect();

      const result = await channel.send({
        id: "out-2",
        channelId: "C01CHANNEL",
        text: "**bold** and ~~strike~~",
        format: "markdown",
      });

      expect(result.ok).toBe(true);
      expect(client.sentMessages[0]?.text).toBe("*bold* and ~strike~");
    });

    test("uses respondInThread config for threadTs", async () => {
      const channel = new SlackChannel(createTestConfig({ respondInThread: true }), client, logger);
      await channel.connect();

      await channel.send({
        id: "out-3",
        channelId: "C01CHANNEL",
        text: "threaded reply",
        replyToId: "1234567890.000000",
      });

      expect(client.sentMessages[0]?.threadTs).toBe("1234567890.000000");
    });

    test("does not use threadTs when respondInThread is false", async () => {
      const channel = new SlackChannel(createTestConfig({ respondInThread: false }), client, logger);
      await channel.connect();

      await channel.send({
        id: "out-4",
        channelId: "C01CHANNEL",
        text: "not threaded",
        replyToId: "1234567890.000000",
      });

      expect(client.sentMessages[0]?.threadTs).toBeUndefined();
    });

    test("splits long messages into chunks", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      await channel.connect();

      const longText = `${"A".repeat(3000)}\n\n${"B".repeat(3000)}`;
      const result = await channel.send({
        id: "out-5",
        channelId: "C01CHANNEL",
        text: longText,
      });

      expect(result.ok).toBe(true);
      expect(client.sentMessages).toHaveLength(2);
    });

    test("returns error when not connected", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      const result = await channel.send({
        id: "out-6",
        channelId: "C01CHANNEL",
        text: "Hello",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CHANNEL_SEND_FAILED");
      }
    });

    test("returns error on send failure", async () => {
      const channel = new SlackChannel(createTestConfig(), client, logger);
      await channel.connect();

      client.shouldFailSend = true;
      client.sendFailMessage = "forbidden";

      const result = await channel.send({
        id: "out-7",
        channelId: "C01CHANNEL",
        text: "This will fail",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CHANNEL_SEND_FAILED");
      }
    });
  });
});
