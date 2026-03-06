import { beforeEach, describe, expect, test } from "bun:test";
import type { EidolonError, InboundMessage, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import type { Logger } from "../../../logging/logger.ts";
import type { WhatsAppApiClient } from "../api.ts";
import type { WhatsAppChannelConfig } from "../channel.ts";
import { WhatsAppChannel } from "../channel.ts";
import type { WhatsAppWebhookEvent } from "../webhook.ts";

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
 * FakeWhatsAppApi implements WhatsAppApiClient for testing.
 * Records all sent messages and allows controlling responses.
 */
class FakeWhatsAppApi implements WhatsAppApiClient {
  readonly sentTexts: Array<{ to: string; text: string; replyToId?: string }> = [];
  readonly sentMedia: Array<{ to: string; type: string; mediaUrl: string; caption?: string }> = [];
  readonly markedAsRead: string[] = [];
  private messageCounter = 0;
  shouldFailSend = false;
  sendFailMessage = "send failed";

  async sendText(to: string, text: string, replyToId?: string): Promise<Result<string, EidolonError>> {
    if (this.shouldFailSend) {
      return { ok: false, error: { code: "WHATSAPP_API_ERROR", message: this.sendFailMessage, timestamp: Date.now() } };
    }
    this.messageCounter++;
    this.sentTexts.push({ to, text, replyToId });
    return Ok(`wamid.test${this.messageCounter}`);
  }

  async sendMedia(
    to: string,
    type: "image" | "document" | "audio" | "video",
    mediaUrl: string,
    caption?: string,
  ): Promise<Result<string, EidolonError>> {
    this.messageCounter++;
    this.sentMedia.push({ to, type, mediaUrl, caption });
    return Ok(`wamid.media${this.messageCounter}`);
  }

  async markAsRead(messageId: string): Promise<Result<void, EidolonError>> {
    this.markedAsRead.push(messageId);
    return Ok(undefined);
  }

  async downloadMedia(_mediaId: string): Promise<Result<Uint8Array, EidolonError>> {
    return Ok(new Uint8Array([0x89, 0x50, 0x4e, 0x47])); // PNG header
  }
}

function createTestConfig(overrides?: Partial<WhatsAppChannelConfig>): WhatsAppChannelConfig {
  return {
    phoneNumberId: "123456789",
    accessToken: "test-access-token",
    verifyToken: "test-verify-token",
    appSecret: "test-app-secret",
    allowedPhoneNumbers: ["+491234567890", "+491234567891"],
    ...overrides,
  };
}

function createWebhookEvent(overrides?: Partial<WhatsAppWebhookEvent>): WhatsAppWebhookEvent {
  return {
    phoneNumberId: "123456789",
    messages: [
      {
        messageId: "wamid.abc123",
        from: "+491234567890",
        timestamp: Date.now(),
        type: "text",
        text: "Hello, Eidolon!",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WhatsAppChannel", () => {
  let api: FakeWhatsAppApi;
  let logger: Logger;

  beforeEach(() => {
    api = new FakeWhatsAppApi();
    logger = createSilentLogger();
  });

  // -- Connection lifecycle -----------------------------------------------

  describe("connect/disconnect", () => {
    test("connects successfully", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      const result = await channel.connect();
      expect(result.ok).toBe(true);
      expect(channel.isConnected()).toBe(true);
    });

    test("returns Ok when already connected", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      await channel.connect();
      const result = await channel.connect();
      expect(result.ok).toBe(true);
    });

    test("disconnects gracefully", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      await channel.connect();
      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    test("disconnect is a no-op when not connected", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      await channel.disconnect(); // should not throw
      expect(channel.isConnected()).toBe(false);
    });
  });

  // -- Channel properties -------------------------------------------------

  describe("properties", () => {
    test("has correct id and name", () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      expect(channel.id).toBe("whatsapp");
      expect(channel.name).toBe("WhatsApp");
    });

    test("reports correct capabilities", () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      expect(channel.capabilities.text).toBe(true);
      expect(channel.capabilities.markdown).toBe(false);
      expect(channel.capabilities.images).toBe(true);
      expect(channel.capabilities.documents).toBe(true);
      expect(channel.capabilities.voice).toBe(true);
      expect(channel.capabilities.reactions).toBe(true);
      expect(channel.capabilities.editing).toBe(false);
      expect(channel.capabilities.streaming).toBe(false);
    });
  });

  // -- Inbound messages ---------------------------------------------------

  describe("inbound messages", () => {
    test("routes authorized messages to handler", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await channel.handleWebhookEvents([createWebhookEvent()]);

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe("Hello, Eidolon!");
      expect(received[0]?.userId).toBe("+491234567890");
      expect(received[0]?.id).toMatch(/^wa-wamid\.abc123-/);
    });

    test("rejects messages from unauthorized phone numbers", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await channel.handleWebhookEvents([
        createWebhookEvent({
          messages: [
            {
              messageId: "wamid.xyz",
              from: "+49999999999", // not in allowedPhoneNumbers
              timestamp: Date.now(),
              type: "text",
              text: "I should not get through",
            },
          ],
        }),
      ]);

      expect(received).toHaveLength(0);
    });

    test("marks messages as read", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      channel.onMessage(async () => {});
      await channel.connect();

      await channel.handleWebhookEvents([createWebhookEvent()]);

      // Give the async mark-as-read a tick to resolve
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(api.markedAsRead).toContain("wamid.abc123");
    });

    test("truncates excessively long inbound text", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      const longText = "A".repeat(200_000);
      await channel.handleWebhookEvents([
        createWebhookEvent({
          messages: [
            {
              messageId: "wamid.long",
              from: "+491234567890",
              timestamp: Date.now(),
              type: "text",
              text: longText,
            },
          ],
        }),
      ]);

      expect(received).toHaveLength(1);
      expect(received[0]?.text?.length).toBe(100_000);
    });

    test("handles media messages with attachments", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      await channel.handleWebhookEvents([
        createWebhookEvent({
          messages: [
            {
              messageId: "wamid.img",
              from: "+491234567890",
              timestamp: Date.now(),
              type: "image",
              mediaId: "media-123",
              mimeType: "image/jpeg",
              caption: "Look at this",
            },
          ],
        }),
      ]);

      expect(received).toHaveLength(1);
      expect(received[0]?.text).toBe("Look at this");
      expect(received[0]?.attachments).toHaveLength(1);
      expect(received[0]?.attachments?.[0]?.type).toBe("image");
      expect(received[0]?.attachments?.[0]?.mimeType).toBe("image/jpeg");
      expect(received[0]?.attachments?.[0]?.url).toBe("whatsapp-media://media-123");
    });

    test("drops messages without a handler gracefully", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      // Do NOT register a handler
      await channel.connect();

      // Should not throw
      await channel.handleWebhookEvents([createWebhookEvent()]);
    });
  });

  // -- Rate limiting ------------------------------------------------------

  describe("rate limiting", () => {
    test("rate limits after 30 messages in 60 seconds", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      const received: InboundMessage[] = [];
      channel.onMessage(async (msg) => {
        received.push(msg);
      });
      await channel.connect();

      // Send 31 messages rapidly
      for (let i = 0; i < 31; i++) {
        await channel.handleWebhookEvents([
          createWebhookEvent({
            messages: [
              {
                messageId: `wamid.msg${i}`,
                from: "+491234567890",
                timestamp: Date.now(),
                type: "text",
                text: `Message ${i}`,
              },
            ],
          }),
        ]);
      }

      // First 30 should be received, 31st dropped
      expect(received).toHaveLength(30);
    });
  });

  // -- Outbound messages --------------------------------------------------

  describe("send", () => {
    test("sends text message after user has messaged (within 24h window)", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      channel.onMessage(async () => {});
      await channel.connect();

      // Simulate inbound to open the 24h window
      await channel.handleWebhookEvents([createWebhookEvent()]);

      const result = await channel.send({
        id: "out-1",
        channelId: "+491234567890",
        text: "Hello from Eidolon!",
      });

      expect(result.ok).toBe(true);
      expect(api.sentTexts).toHaveLength(1);
      expect(api.sentTexts[0]?.text).toBe("Hello from Eidolon!");
      expect(api.sentTexts[0]?.to).toBe("+491234567890");
    });

    test("returns error when not connected", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      const result = await channel.send({
        id: "out-1",
        channelId: "+491234567890",
        text: "Hello",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CHANNEL_SEND_FAILED");
      }
    });

    test("returns error when outside 24h messaging window", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      await channel.connect();

      // No inbound message received -> no 24h window open
      const result = await channel.send({
        id: "out-1",
        channelId: "+491234567890",
        text: "Hello",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("24-hour messaging window");
      }
    });

    test("splits long messages into chunks", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      channel.onMessage(async () => {});
      await channel.connect();

      // Open 24h window
      await channel.handleWebhookEvents([createWebhookEvent()]);

      const longText = `${"A".repeat(3000)}\n\n${"B".repeat(3000)}`;
      const result = await channel.send({
        id: "out-2",
        channelId: "+491234567890",
        text: longText,
      });

      expect(result.ok).toBe(true);
      expect(api.sentTexts).toHaveLength(2);
    });

    test("returns error on API send failure", async () => {
      const channel = new WhatsAppChannel(createTestConfig(), api, logger);
      channel.onMessage(async () => {});
      await channel.connect();

      // Open 24h window
      await channel.handleWebhookEvents([createWebhookEvent()]);

      api.shouldFailSend = true;
      api.sendFailMessage = "Service temporarily unavailable";

      const result = await channel.send({
        id: "out-3",
        channelId: "+491234567890",
        text: "This will fail",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CHANNEL_SEND_FAILED");
      }
    });
  });
});
