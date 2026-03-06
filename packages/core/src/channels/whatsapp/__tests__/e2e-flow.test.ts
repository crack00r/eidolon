/**
 * End-to-end integration tests for WhatsApp channel.
 *
 * Tests the full inbound/outbound flow:
 * - Webhook verification challenge
 * - Webhook signature validation (HMAC-SHA256)
 * - Webhook payload parsing (nested Meta format)
 * - Inbound: webhook event -> authorization -> rate limit -> message handler
 * - Outbound: send with 24-hour window enforcement, message splitting
 * - Media message handling (image, document, audio, video)
 * - Threading: inbound updates messaging window, enabling outbound
 * - Rate limiting integration across inbound + outbound
 *
 * Uses FakeWhatsAppApi (injectable WhatsAppApiClient) for all API calls.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import type { EidolonError, InboundMessage, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import type { Logger } from "../../../logging/logger.ts";
import type { WhatsAppApiClient } from "../api.ts";
import type { WhatsAppChannelConfig } from "../channel.ts";
import { WhatsAppChannel } from "../channel.ts";
import { formatForWhatsApp, splitWhatsAppMessage } from "../formatter.ts";
import { handleVerificationChallenge, parseWebhookPayload, verifyWebhookSignature } from "../webhook.ts";

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
    return Ok(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  }
}

function createTestConfig(overrides?: Partial<WhatsAppChannelConfig>): WhatsAppChannelConfig {
  return {
    phoneNumberId: "123456789",
    accessToken: "test-access-token",
    verifyToken: "test-verify-token",
    appSecret: "test-app-secret-key",
    allowedPhoneNumbers: ["+491234567890", "+491234567891"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// E2E: Webhook verification
// ---------------------------------------------------------------------------

describe("WhatsApp webhook verification", () => {
  test("responds with challenge when tokens match", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "my-token",
      "hub.challenge": "challenge-12345",
    });
    const result = handleVerificationChallenge(params, "my-token");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("challenge-12345");
    }
  });

  test("rejects when hub.mode is not subscribe", () => {
    const params = new URLSearchParams({
      "hub.mode": "unsubscribe",
      "hub.verify_token": "my-token",
      "hub.challenge": "challenge-12345",
    });
    const result = handleVerificationChallenge(params, "my-token");
    expect(result.ok).toBe(false);
  });

  test("rejects when tokens do not match", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
      "hub.challenge": "challenge-12345",
    });
    const result = handleVerificationChallenge(params, "my-token");
    expect(result.ok).toBe(false);
  });

  test("rejects when challenge is missing", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "my-token",
    });
    const result = handleVerificationChallenge(params, "my-token");
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E2E: Webhook signature verification
// ---------------------------------------------------------------------------

describe("WhatsApp webhook signature", () => {
  test("valid signature returns true", async () => {
    const body = '{"test":"data"}';
    const secret = "test-secret";
    // Compute expected signature using Web Crypto (same as the implementation)
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const hexDigest = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const expected = `sha256=${hexDigest}`;

    const result = await verifyWebhookSignature(body, expected, secret);
    expect(result).toBe(true);
  });

  test("invalid signature returns false", async () => {
    const body = '{"test":"data"}';
    const secret = "test-secret";
    const result = await verifyWebhookSignature(
      body,
      "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      secret,
    );
    expect(result).toBe(false);
  });

  test("missing sha256 prefix returns false", async () => {
    const result = await verifyWebhookSignature('{"test":"data"}', "invalid-format", "secret");
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// E2E: Webhook payload parsing
// ---------------------------------------------------------------------------

describe("WhatsApp webhook payload parsing", () => {
  test("parses standard text message payload", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "BUSINESS_ID",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    from: "+491234567890",
                    id: "wamid.abc123",
                    timestamp: "1709312400",
                    type: "text",
                    text: { body: "Hello!" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const result = parseWebhookPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.phoneNumberId).toBe("123456789");
      expect(result.value[0]?.messages).toHaveLength(1);
      expect(result.value[0]?.messages[0]?.from).toBe("+491234567890");
      expect(result.value[0]?.messages[0]?.text).toBe("Hello!");
      expect(result.value[0]?.messages[0]?.type).toBe("text");
    }
  });

  test("parses image message with media ID", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "BID",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "123" },
                messages: [
                  {
                    from: "+491234567890",
                    id: "wamid.img1",
                    timestamp: "1709312400",
                    type: "image",
                    image: { id: "media-456", mime_type: "image/jpeg", caption: "photo" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const result = parseWebhookPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const msg = result.value[0]?.messages[0];
      expect(msg?.type).toBe("image");
      expect(msg?.mediaId).toBe("media-456");
      expect(msg?.mimeType).toBe("image/jpeg");
      expect(msg?.caption).toBe("photo");
    }
  });

  test("returns empty events for non-message payload", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "BID",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "123" },
                statuses: [{ id: "wamid.status1", status: "delivered" }],
              },
              field: "messages",
            },
          ],
        },
      ],
    };

    const result = parseWebhookPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Events parsed but no messages
      const totalMessages = result.value.reduce((sum, e) => sum + e.messages.length, 0);
      expect(totalMessages).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// E2E: Full inbound -> handler -> outbound flow
// ---------------------------------------------------------------------------

describe("WhatsApp E2E inbound -> outbound flow", () => {
  let api: FakeWhatsAppApi;
  let logger: Logger;

  beforeEach(() => {
    api = new FakeWhatsAppApi();
    logger = createSilentLogger();
  });

  test("complete flow: inbound webhook -> handler -> outbound reply", async () => {
    const config = createTestConfig();
    const channel = new WhatsAppChannel(config, api, logger);

    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    // Step 1: Inbound webhook event
    await channel.handleWebhookEvents([
      {
        phoneNumberId: "123456789",
        messages: [
          {
            messageId: "wamid.inbound1",
            from: "+491234567890",
            timestamp: Date.now(),
            type: "text",
            text: "Hi Eidolon!",
          },
        ],
      },
    ]);

    // Verify handler received the message
    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("Hi Eidolon!");
    expect(received[0]?.userId).toBe("+491234567890");

    // Step 2: Outbound reply (24h window now open)
    const sendResult = await channel.send({
      id: "out-reply-1",
      channelId: "+491234567890",
      text: "Hello! How can I help?",
    });

    expect(sendResult.ok).toBe(true);
    expect(api.sentTexts).toHaveLength(1);
    expect(api.sentTexts[0]?.to).toBe("+491234567890");
    expect(api.sentTexts[0]?.text).toBe("Hello! How can I help?");

    // Step 3: Verify message was marked as read
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.markedAsRead).toContain("wamid.inbound1");

    // Step 4: Disconnect
    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  test("inbound from unauthorized number is silently dropped", async () => {
    const channel = new WhatsAppChannel(createTestConfig(), api, logger);
    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });
    await channel.connect();

    await channel.handleWebhookEvents([
      {
        phoneNumberId: "123456789",
        messages: [
          {
            messageId: "wamid.unauth",
            from: "+49000000000", // Not in allowlist
            timestamp: Date.now(),
            type: "text",
            text: "I should be dropped",
          },
        ],
      },
    ]);

    expect(received).toHaveLength(0);
  });

  test("outbound fails when no inbound established 24h window", async () => {
    const channel = new WhatsAppChannel(createTestConfig(), api, logger);
    await channel.connect();

    const result = await channel.send({
      id: "out-1",
      channelId: "+491234567890",
      text: "Proactive message",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("24-hour messaging window");
    }
  });

  test("multiple messages from different allowed numbers open independent windows", async () => {
    const channel = new WhatsAppChannel(createTestConfig(), api, logger);
    channel.onMessage(async () => {});
    await channel.connect();

    // Inbound from number 1
    await channel.handleWebhookEvents([
      {
        phoneNumberId: "123456789",
        messages: [{ messageId: "w1", from: "+491234567890", timestamp: Date.now(), type: "text", text: "Hello" }],
      },
    ]);

    // Outbound to number 1 succeeds
    const result1 = await channel.send({ id: "o1", channelId: "+491234567890", text: "Reply 1" });
    expect(result1.ok).toBe(true);

    // Outbound to number 2 fails (no inbound yet)
    const result2 = await channel.send({ id: "o2", channelId: "+491234567891", text: "Reply 2" });
    expect(result2.ok).toBe(false);

    // Inbound from number 2
    await channel.handleWebhookEvents([
      {
        phoneNumberId: "123456789",
        messages: [{ messageId: "w2", from: "+491234567891", timestamp: Date.now(), type: "text", text: "Hi" }],
      },
    ]);

    // Now outbound to number 2 succeeds
    const result3 = await channel.send({ id: "o3", channelId: "+491234567891", text: "Reply 2" });
    expect(result3.ok).toBe(true);
  });

  test("rate limiting drops messages beyond 30 per minute", async () => {
    const channel = new WhatsAppChannel(createTestConfig(), api, logger);
    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });
    await channel.connect();

    for (let i = 0; i < 35; i++) {
      await channel.handleWebhookEvents([
        {
          phoneNumberId: "123456789",
          messages: [
            {
              messageId: `wamid.rl${i}`,
              from: "+491234567890",
              timestamp: Date.now(),
              type: "text",
              text: `Message ${i}`,
            },
          ],
        },
      ]);
    }

    // 30 messages through, 5 dropped
    expect(received).toHaveLength(30);
  });

  test("image media message produces attachment with whatsapp-media:// URL", async () => {
    const channel = new WhatsAppChannel(createTestConfig(), api, logger);
    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });
    await channel.connect();

    await channel.handleWebhookEvents([
      {
        phoneNumberId: "123456789",
        messages: [
          {
            messageId: "wamid.media1",
            from: "+491234567890",
            timestamp: Date.now(),
            type: "image",
            mediaId: "media-img-42",
            mimeType: "image/jpeg",
            caption: "Check this out",
          },
        ],
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0]?.text).toBe("Check this out");
    expect(received[0]?.attachments).toHaveLength(1);
    expect(received[0]?.attachments?.[0]?.type).toBe("image");
    expect(received[0]?.attachments?.[0]?.url).toBe("whatsapp-media://media-img-42");
  });

  test("document media message has correct attachment type", async () => {
    const channel = new WhatsAppChannel(createTestConfig(), api, logger);
    const received: InboundMessage[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });
    await channel.connect();

    await channel.handleWebhookEvents([
      {
        phoneNumberId: "123456789",
        messages: [
          {
            messageId: "wamid.doc1",
            from: "+491234567890",
            timestamp: Date.now(),
            type: "document",
            mediaId: "media-doc-1",
            mimeType: "application/pdf",
            filename: "report.pdf",
          },
        ],
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0]?.attachments?.[0]?.type).toBe("document");
    expect(received[0]?.attachments?.[0]?.url).toBe("whatsapp-media://media-doc-1");
  });

  test("long outbound message is split into chunks", async () => {
    const channel = new WhatsAppChannel(createTestConfig(), api, logger);
    channel.onMessage(async () => {});
    await channel.connect();

    // Open 24h window
    await channel.handleWebhookEvents([
      {
        phoneNumberId: "123456789",
        messages: [{ messageId: "w1", from: "+491234567890", timestamp: Date.now(), type: "text", text: "Hi" }],
      },
    ]);

    const longText = `${"A".repeat(3000)}\n\n${"B".repeat(3000)}`;
    const result = await channel.send({ id: "out-long", channelId: "+491234567890", text: longText });

    expect(result.ok).toBe(true);
    expect(api.sentTexts.length).toBeGreaterThanOrEqual(2);
  });

  test("API send failure propagates as error result", async () => {
    const channel = new WhatsAppChannel(createTestConfig(), api, logger);
    channel.onMessage(async () => {});
    await channel.connect();

    await channel.handleWebhookEvents([
      {
        phoneNumberId: "123456789",
        messages: [{ messageId: "w1", from: "+491234567890", timestamp: Date.now(), type: "text", text: "Hi" }],
      },
    ]);

    api.shouldFailSend = true;
    const result = await channel.send({ id: "out-fail", channelId: "+491234567890", text: "Will fail" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CHANNEL_SEND_FAILED");
    }
  });

  test("disconnect clears messaging windows and rate limits", async () => {
    const channel = new WhatsAppChannel(createTestConfig(), api, logger);
    channel.onMessage(async () => {});
    await channel.connect();

    // Open window
    await channel.handleWebhookEvents([
      {
        phoneNumberId: "123456789",
        messages: [{ messageId: "w1", from: "+491234567890", timestamp: Date.now(), type: "text", text: "Hi" }],
      },
    ]);

    await channel.disconnect();
    await channel.connect();

    // Window should be cleared after disconnect
    const result = await channel.send({ id: "out-after", channelId: "+491234567890", text: "After reconnect" });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// WhatsApp message formatter
// ---------------------------------------------------------------------------

describe("WhatsApp message formatting", () => {
  test("formatForWhatsApp converts markdown bold to WhatsApp bold", () => {
    const result = formatForWhatsApp("Hello **world**");
    expect(result).toContain("*world*");
    expect(result).not.toContain("**");
  });

  test("splitWhatsAppMessage keeps short messages intact", () => {
    const chunks = splitWhatsAppMessage("Short message");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Short message");
  });

  test("splitWhatsAppMessage splits at 4096 boundary", () => {
    const longText = "X".repeat(5000);
    const chunks = splitWhatsAppMessage(longText);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});
