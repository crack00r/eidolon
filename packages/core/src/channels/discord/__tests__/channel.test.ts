import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { InboundMessage } from "@eidolon/protocol";
import type { Logger } from "../../../logging/logger.ts";
import type {
  DiscordAttachment,
  DiscordConfig,
  DiscordInboundMessage,
  DiscordMessage,
  IDiscordClient,
} from "../channel.ts";
import { DiscordChannel } from "../channel.ts";

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
 * FakeDiscordClient implements IDiscordClient for testing.
 * Records all sent/edited messages and allows simulating incoming messages.
 */
class FakeDiscordClient implements IDiscordClient {
  private ready = false;
  private messageHandlers: Array<(msg: DiscordInboundMessage) => Promise<void>> = [];
  readonly sentMessages: Array<{ channelId: string; content: string }> = [];
  readonly editedMessages: Array<{ channelId: string; messageId: string; content: string }> = [];
  private messageCounter = 0;
  loginCallCount = 0;
  destroyCallCount = 0;
  shouldFailLogin = false;
  shouldFailSend = false;
  sendFailMessage = "send failed";

  async login(_token: string): Promise<void> {
    this.loginCallCount++;
    if (this.shouldFailLogin) {
      throw new Error("Login failed: invalid token");
    }
    this.ready = true;
  }

  async destroy(): Promise<void> {
    this.destroyCallCount++;
    this.ready = false;
  }

  onMessage(handler: (message: DiscordInboundMessage) => Promise<void>): void {
    this.messageHandlers.push(handler);
  }

  async sendMessage(channelId: string, content: string): Promise<DiscordMessage> {
    if (this.shouldFailSend) {
      throw new Error(this.sendFailMessage);
    }
    this.messageCounter++;
    const msg: DiscordMessage = {
      id: `msg-${this.messageCounter}`,
      content,
      channelId,
    };
    this.sentMessages.push({ channelId, content });
    return msg;
  }

  async editMessage(channelId: string, messageId: string, content: string): Promise<DiscordMessage> {
    this.editedMessages.push({ channelId, messageId, content });
    return { id: messageId, content, channelId };
  }

  isReady(): boolean {
    return this.ready;
  }

  /** Simulate an incoming message for testing. */
  async simulateMessage(msg: DiscordInboundMessage): Promise<void> {
    for (const handler of this.messageHandlers) {
      await handler(msg);
    }
  }
}

function createTestConfig(overrides?: Partial<DiscordConfig>): DiscordConfig {
  return {
    botToken: "test-token-123",
    allowedUserIds: ["user-1", "user-2"],
    dmOnly: true,
    ...overrides,
  };
}

function createInboundMessage(overrides?: Partial<DiscordInboundMessage>): DiscordInboundMessage {
  return {
    id: "discord-msg-1",
    content: "Hello, Eidolon!",
    channelId: "dm-channel-1",
    author: { id: "user-1", username: "testuser" },
    guildId: null,
    attachments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiscordChannel", () => {
  let client: FakeDiscordClient;
  let logger: Logger;

  beforeEach(() => {
    client = new FakeDiscordClient();
    logger = createSilentLogger();
  });

  // -- Connection lifecycle ---------------------------------------------------

  describe("connect/disconnect", () => {
    test("connects successfully with valid token", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      const result = await channel.connect();
      expect(result.ok).toBe(true);
      expect(channel.isConnected()).toBe(true);
      expect(client.loginCallCount).toBe(1);
    });

    test("returns Ok when already connected", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      await channel.connect();
      const result = await channel.connect();
      expect(result.ok).toBe(true);
      // Should not call login again
      expect(client.loginCallCount).toBe(1);
    });

    test("returns Err on login failure", async () => {
      client.shouldFailLogin = true;
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      const result = await channel.connect();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CHANNEL_AUTH_FAILED");
      }
      expect(channel.isConnected()).toBe(false);
    });

    test("disconnects gracefully", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
      expect(client.destroyCallCount).toBe(1);
    });

    test("disconnect is a no-op when not connected", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      await channel.disconnect();
      expect(client.destroyCallCount).toBe(0);
    });
  });

  // -- Channel properties -----------------------------------------------------

  describe("properties", () => {
    test("has correct id and name", () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      expect(channel.id).toBe("discord");
      expect(channel.name).toBe("Discord");
    });

    test("reports correct capabilities", () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      expect(channel.capabilities.text).toBe(true);
      expect(channel.capabilities.markdown).toBe(true);
      expect(channel.capabilities.images).toBe(true);
      expect(channel.capabilities.documents).toBe(true);
      expect(channel.capabilities.voice).toBe(false);
      expect(channel.capabilities.reactions).toBe(true);
      expect(channel.capabilities.editing).toBe(true);
      expect(channel.capabilities.streaming).toBe(false);
    });
  });

  // -- Inbound messages -------------------------------------------------------

  describe("inbound messages", () => {
    test("routes authorized DM messages to handler", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateMessage(createInboundMessage());

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe("Hello, Eidolon!");
      expect(received[0]?.userId).toBe("user-1");
      expect(received[0]?.id).toMatch(/^dc-discord-msg-1-/);
    });

    test("rejects messages from unauthorized users", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateMessage(
        createInboundMessage({
          author: { id: "unauthorized-user", username: "hacker" },
        }),
      );

      expect(received).toHaveLength(0);
    });

    test("ignores bot messages", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateMessage(
        createInboundMessage({
          author: { id: "user-1", username: "testbot", bot: true },
        }),
      );

      expect(received).toHaveLength(0);
    });

    test("enforces DM-only mode by ignoring guild messages", async () => {
      const channel = new DiscordChannel(
        createTestConfig({ dmOnly: true }),
        client,
        logger,
      );
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateMessage(
        createInboundMessage({ guildId: "guild-123" }),
      );

      expect(received).toHaveLength(0);
    });

    test("allows guild messages when dmOnly is false", async () => {
      const channel = new DiscordChannel(
        createTestConfig({ dmOnly: false }),
        client,
        logger,
      );
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await client.simulateMessage(
        createInboundMessage({ guildId: "guild-123" }),
      );

      expect(received).toHaveLength(1);
    });

    test("restricts to configured guildId when set", async () => {
      const channel = new DiscordChannel(
        createTestConfig({ dmOnly: false, guildId: "guild-abc" }),
        client,
        logger,
      );
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      // Wrong guild
      await client.simulateMessage(
        createInboundMessage({ guildId: "guild-xyz" }),
      );
      expect(received).toHaveLength(0);

      // Correct guild
      await client.simulateMessage(
        createInboundMessage({ guildId: "guild-abc" }),
      );
      expect(received).toHaveLength(1);
    });

    test("truncates excessively long inbound text", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      const longText = "A".repeat(200_000);
      await client.simulateMessage(createInboundMessage({ content: longText }));

      expect(received).toHaveLength(1);
      // Truncated to 100_000 characters
      expect(received[0]?.text?.length).toBe(100_000);
    });

    test("converts attachments correctly", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      const attachments: DiscordAttachment[] = [
        {
          id: "att-1",
          url: "https://cdn.discord.com/image.png",
          filename: "image.png",
          contentType: "image/png",
          size: 1024,
        },
        {
          id: "att-2",
          url: "https://cdn.discord.com/file.pdf",
          filename: "file.pdf",
          contentType: "application/pdf",
          size: 2048,
        },
      ];

      await client.simulateMessage(createInboundMessage({ attachments }));

      expect(received).toHaveLength(1);
      expect(received[0]?.attachments).toHaveLength(2);
      expect(received[0]?.attachments?.[0]?.type).toBe("image");
      expect(received[0]?.attachments?.[0]?.url).toBe("https://cdn.discord.com/image.png");
      expect(received[0]?.attachments?.[1]?.type).toBe("document");
    });

    test("drops no-handler messages gracefully", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      // Do NOT register a handler
      await channel.connect();

      // Should not throw
      await client.simulateMessage(createInboundMessage());
    });
  });

  // -- Rate limiting ----------------------------------------------------------

  describe("rate limiting", () => {
    test("rate limits after 30 messages in 60 seconds", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      // Send 31 messages rapidly
      for (let i = 0; i < 31; i++) {
        await client.simulateMessage(
          createInboundMessage({ id: `msg-${i}` }),
        );
      }

      // First 30 should be received, 31st dropped
      expect(received).toHaveLength(30);
    });
  });

  // -- Outbound messages ------------------------------------------------------

  describe("send", () => {
    test("sends text message to channel", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      await channel.connect();

      const result = await channel.send({
        id: "out-1",
        channelId: "dm-channel-1",
        text: "Hello from Eidolon!",
      });

      expect(result.ok).toBe(true);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.content).toBe("Hello from Eidolon!");
      expect(client.sentMessages[0]?.channelId).toBe("dm-channel-1");
    });

    test("returns error when not connected", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      const result = await channel.send({
        id: "out-1",
        channelId: "dm-channel-1",
        text: "Hello",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CHANNEL_SEND_FAILED");
      }
    });

    test("splits long messages into chunks", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      await channel.connect();

      const longText = "A".repeat(1500) + "\n\n" + "B".repeat(1500);
      const result = await channel.send({
        id: "out-2",
        channelId: "dm-channel-1",
        text: longText,
      });

      expect(result.ok).toBe(true);
      expect(client.sentMessages).toHaveLength(2);
    });

    test("returns error on send failure", async () => {
      const channel = new DiscordChannel(createTestConfig(), client, logger);
      await channel.connect();

      // Make the first send fail non-transiently
      client.shouldFailSend = true;
      client.sendFailMessage = "forbidden";

      const result = await channel.send({
        id: "out-3",
        channelId: "dm-channel-1",
        text: "This will fail",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CHANNEL_SEND_FAILED");
      }
    });
  });
});
