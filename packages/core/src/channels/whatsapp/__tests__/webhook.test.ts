import { describe, expect, test } from "bun:test";
import { handleVerificationChallenge, parseWebhookPayload, verifyWebhookSignature } from "../webhook.ts";

// ---------------------------------------------------------------------------
// handleVerificationChallenge
// ---------------------------------------------------------------------------

describe("handleVerificationChallenge", () => {
  const VERIFY_TOKEN = "my-secret-verify-token";

  test("returns challenge on valid verification request", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "challenge-12345",
    });

    const result = handleVerificationChallenge(params, VERIFY_TOKEN);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe("challenge-12345");
    }
  });

  test("returns error when hub.mode is not subscribe", () => {
    const params = new URLSearchParams({
      "hub.mode": "unsubscribe",
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "challenge-12345",
    });

    const result = handleVerificationChallenge(params, VERIFY_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WHATSAPP_WEBHOOK_INVALID");
      expect(result.error.message).toContain("Invalid hub.mode");
    }
  });

  test("returns error when hub.mode is missing", () => {
    const params = new URLSearchParams({
      "hub.verify_token": VERIFY_TOKEN,
      "hub.challenge": "challenge-12345",
    });

    const result = handleVerificationChallenge(params, VERIFY_TOKEN);
    expect(result.ok).toBe(false);
  });

  test("returns error when verify_token does not match", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": "wrong-token",
      "hub.challenge": "challenge-12345",
    });

    const result = handleVerificationChallenge(params, VERIFY_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Verify token mismatch");
    }
  });

  test("returns error when challenge is missing", () => {
    const params = new URLSearchParams({
      "hub.mode": "subscribe",
      "hub.verify_token": VERIFY_TOKEN,
    });

    const result = handleVerificationChallenge(params, VERIFY_TOKEN);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Missing hub.verify_token or hub.challenge");
    }
  });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature
// ---------------------------------------------------------------------------

describe("verifyWebhookSignature", () => {
  const APP_SECRET = "test-app-secret-12345";

  test("returns true for valid HMAC-SHA256 signature", async () => {
    const body = JSON.stringify({ test: "data" });

    // Compute expected signature using Web Crypto API
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const result = await verifyWebhookSignature(body, `sha256=${hex}`, APP_SECRET);
    expect(result).toBe(true);
  });

  test("returns false for invalid signature", async () => {
    const body = JSON.stringify({ test: "data" });
    const result = await verifyWebhookSignature(body, "sha256=0000000000000000000000000000000000000000000000000000000000000000", APP_SECRET);
    expect(result).toBe(false);
  });

  test("returns false when signature prefix is missing", async () => {
    const body = JSON.stringify({ test: "data" });
    const result = await verifyWebhookSignature(body, "invalid-prefix", APP_SECRET);
    expect(result).toBe(false);
  });

  test("returns false when signature length does not match", async () => {
    const body = JSON.stringify({ test: "data" });
    const result = await verifyWebhookSignature(body, "sha256=0000", APP_SECRET);
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseWebhookPayload
// ---------------------------------------------------------------------------

describe("parseWebhookPayload", () => {
  test("parses a valid webhook payload with text message", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "entry-1",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    id: "wamid.abc123",
                    from: "+491234567890",
                    timestamp: "1700000000",
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
      expect(result.value[0]?.messages[0]?.messageId).toBe("wamid.abc123");
      expect(result.value[0]?.messages[0]?.from).toBe("+491234567890");
      expect(result.value[0]?.messages[0]?.type).toBe("text");
      expect(result.value[0]?.messages[0]?.text).toBe("Hello!");
      // Timestamp converted from seconds to ms
      expect(result.value[0]?.messages[0]?.timestamp).toBe(1700000000000);
    }
  });

  test("parses image message with media fields", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    id: "wamid.img1",
                    from: "+491234567890",
                    timestamp: "1700000000",
                    type: "image",
                    image: {
                      id: "media-id-123",
                      mime_type: "image/jpeg",
                      caption: "A photo",
                    },
                  },
                ],
              },
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
      expect(msg?.mediaId).toBe("media-id-123");
      expect(msg?.mimeType).toBe("image/jpeg");
      expect(msg?.caption).toBe("A photo");
    }
  });

  test("parses document message with filename", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    id: "wamid.doc1",
                    from: "+491234567890",
                    timestamp: "1700000000",
                    type: "document",
                    document: {
                      id: "media-doc-456",
                      mime_type: "application/pdf",
                      filename: "report.pdf",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = parseWebhookPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const msg = result.value[0]?.messages[0];
      expect(msg?.type).toBe("document");
      expect(msg?.filename).toBe("report.pdf");
    }
  });

  test("parses reaction message", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    id: "wamid.react1",
                    from: "+491234567890",
                    timestamp: "1700000000",
                    type: "reaction",
                    reaction: {
                      message_id: "wamid.original",
                      emoji: "thumbs_up",
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = parseWebhookPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const msg = result.value[0]?.messages[0];
      expect(msg?.type).toBe("reaction");
      expect(msg?.reaction?.messageId).toBe("wamid.original");
      expect(msg?.reaction?.emoji).toBe("thumbs_up");
    }
  });

  test("returns error for non-object body", () => {
    const result = parseWebhookPayload("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WHATSAPP_WEBHOOK_INVALID");
    }
  });

  test("returns error for wrong object type", () => {
    const result = parseWebhookPayload({ object: "page" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unexpected object type");
    }
  });

  test("returns error for missing entry array", () => {
    const result = parseWebhookPayload({ object: "whatsapp_business_account" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Missing or invalid entry array");
    }
  });

  test("returns empty events for entries with no messages", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                statuses: [{ id: "wamid.status1", status: "delivered" }],
              },
            },
          ],
        },
      ],
    };

    const result = parseWebhookPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  test("skips messages with missing id or from", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  { from: "+491234567890", timestamp: "1700000000", type: "text", text: { body: "No id" } },
                  { id: "wamid.valid", from: "+491234567890", timestamp: "1700000000", type: "text", text: { body: "Valid" } },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = parseWebhookPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Only the valid message with both id and from should be parsed
      expect(result.value[0]?.messages).toHaveLength(1);
      expect(result.value[0]?.messages[0]?.text).toBe("Valid");
    }
  });

  test("handles unknown message types gracefully", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: "123456789" },
                messages: [
                  {
                    id: "wamid.unknown",
                    from: "+491234567890",
                    timestamp: "1700000000",
                    type: "sticker",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const result = parseWebhookPayload(payload);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.messages[0]?.type).toBe("unknown");
    }
  });
});
