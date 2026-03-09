/**
 * WhatsApp webhook handler: payload parsing + HMAC-SHA256 verification.
 *
 * Handles both GET (verification challenge) and POST (event delivery)
 * from the Meta WhatsApp Cloud API webhook system.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { constantTimeCompare } from "../../gateway/server-helpers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WhatsAppMessageType = "text" | "image" | "document" | "audio" | "video" | "reaction" | "unknown";

export interface WhatsAppWebhookMessage {
  readonly messageId: string;
  readonly from: string;
  readonly timestamp: number;
  readonly type: WhatsAppMessageType;
  readonly text?: string;
  readonly mediaId?: string;
  readonly mimeType?: string;
  readonly filename?: string;
  readonly caption?: string;
  readonly reaction?: { readonly messageId: string; readonly emoji: string };
}

export interface WhatsAppWebhookEvent {
  readonly phoneNumberId: string;
  readonly messages: readonly WhatsAppWebhookMessage[];
}

// ---------------------------------------------------------------------------
// Verification challenge
// ---------------------------------------------------------------------------

/**
 * Handle the GET webhook verification challenge from Meta.
 *
 * Meta sends: hub.mode=subscribe, hub.verify_token=<token>, hub.challenge=<random>
 * We must respond with the challenge value if the verify_token matches.
 */
export function handleVerificationChallenge(
  params: URLSearchParams,
  verifyToken: string,
): Result<string, EidolonError> {
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode !== "subscribe") {
    return Err(createError(ErrorCode.WHATSAPP_WEBHOOK_INVALID, `Invalid hub.mode: ${mode ?? "missing"}`));
  }

  if (!token || !challenge) {
    return Err(createError(ErrorCode.WHATSAPP_WEBHOOK_INVALID, "Missing hub.verify_token or hub.challenge"));
  }

  if (challenge.length > 1024) {
    return Err(createError(ErrorCode.WHATSAPP_WEBHOOK_INVALID, "hub.challenge exceeds maximum length"));
  }

  // Constant-time comparison to prevent timing attacks
  if (!constantTimeCompare(token, verifyToken)) {
    return Err(createError(ErrorCode.WHATSAPP_WEBHOOK_INVALID, "Verify token mismatch"));
  }

  return Ok(challenge);
}

// ---------------------------------------------------------------------------
// Signature verification
// ---------------------------------------------------------------------------

/**
 * Verify the HMAC-SHA256 signature from Meta's X-Hub-Signature-256 header.
 *
 * Header format: sha256=<hex-encoded-hmac>
 * Uses Web Crypto API for HMAC computation and constant-time comparison.
 */
export async function verifyWebhookSignature(body: string, signature: string, appSecret: string): Promise<boolean> {
  if (!signature.startsWith("sha256=")) return false;
  const expectedHex = signature.slice(7);

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));

  const actualHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison (reuse shared helper)
  return constantTimeCompare(actualHex, expectedHex);
}

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

/**
 * Parse a WhatsApp webhook POST body into structured events.
 *
 * The Meta webhook format nests messages inside:
 *   body.entry[].changes[].value.messages[]
 *
 * Each entry may contain multiple changes and each change may contain
 * multiple messages.
 */
export function parseWebhookPayload(body: unknown): Result<WhatsAppWebhookEvent[], EidolonError> {
  if (typeof body !== "object" || body === null) {
    return Err(createError(ErrorCode.WHATSAPP_WEBHOOK_INVALID, "Webhook body is not an object"));
  }

  const payload = body as Record<string, unknown>;

  if (payload.object !== "whatsapp_business_account") {
    return Err(
      createError(ErrorCode.WHATSAPP_WEBHOOK_INVALID, `Unexpected object type: ${String(payload.object ?? "missing")}`),
    );
  }

  const entries = payload.entry;
  if (!Array.isArray(entries)) {
    return Err(createError(ErrorCode.WHATSAPP_WEBHOOK_INVALID, "Missing or invalid entry array"));
  }

  const events: WhatsAppWebhookEvent[] = [];

  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const entryObj = entry as Record<string, unknown>;

    const changes = entryObj.changes;
    if (!Array.isArray(changes)) continue;

    for (const change of changes) {
      if (typeof change !== "object" || change === null) continue;
      const changeObj = change as Record<string, unknown>;

      const value = changeObj.value;
      if (typeof value !== "object" || value === null) continue;
      const valueObj = value as Record<string, unknown>;

      const metadata = valueObj.metadata;
      const phoneNumberId =
        typeof metadata === "object" && metadata !== null
          ? String((metadata as Record<string, unknown>).phone_number_id ?? "")
          : "";

      const rawMessages = valueObj.messages;
      if (!Array.isArray(rawMessages)) continue;

      const messages: WhatsAppWebhookMessage[] = [];

      for (const msg of rawMessages) {
        const parsed = parseMessage(msg);
        if (parsed) {
          messages.push(parsed);
        }
      }

      if (messages.length > 0) {
        events.push({ phoneNumberId, messages });
      }
    }
  }

  return Ok(events);
}

// ---------------------------------------------------------------------------
// Message parsing helpers
// ---------------------------------------------------------------------------

function parseMessage(msg: unknown): WhatsAppWebhookMessage | null {
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;

  const messageId = typeof m.id === "string" ? m.id : "";
  const from = typeof m.from === "string" ? m.from : "";
  const rawTimestamp = typeof m.timestamp === "string" ? Number(m.timestamp) : 0;
  const timestamp = rawTimestamp * 1000; // Convert seconds to ms

  if (!messageId || !from) return null;

  const rawType = typeof m.type === "string" ? m.type : "unknown";
  const type = normalizeMessageType(rawType);

  const base = { messageId, from, timestamp, type };

  switch (type) {
    case "text": {
      const textObj = m.text;
      const text =
        typeof textObj === "object" && textObj !== null ? String((textObj as Record<string, unknown>).body ?? "") : "";
      return { ...base, text };
    }
    case "image":
    case "document":
    case "audio":
    case "video": {
      const mediaObj = m[rawType];
      if (typeof mediaObj !== "object" || mediaObj === null) return { ...base };
      const media = mediaObj as Record<string, unknown>;
      return {
        ...base,
        mediaId: typeof media.id === "string" ? media.id : undefined,
        mimeType: typeof media.mime_type === "string" ? media.mime_type : undefined,
        filename: typeof media.filename === "string" ? media.filename : undefined,
        caption: typeof media.caption === "string" ? media.caption : undefined,
      };
    }
    case "reaction": {
      const reactionObj = m.reaction;
      if (typeof reactionObj !== "object" || reactionObj === null) return { ...base };
      const reaction = reactionObj as Record<string, unknown>;
      return {
        ...base,
        reaction: {
          messageId: typeof reaction.message_id === "string" ? reaction.message_id : "",
          emoji: typeof reaction.emoji === "string" ? reaction.emoji : "",
        },
      };
    }
    default:
      return { ...base };
  }
}

function normalizeMessageType(raw: string): WhatsAppMessageType {
  switch (raw) {
    case "text":
    case "image":
    case "document":
    case "audio":
    case "video":
    case "reaction":
      return raw;
    default:
      return "unknown";
  }
}
