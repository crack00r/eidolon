/**
 * Webhook ingestion endpoint for the gateway.
 *
 * Allows external services (GitHub, monitoring tools, CI/CD, home automation)
 * to push events into Eidolon via HTTP POST. The handler validates, authenticates,
 * and sanitizes payloads but does NOT publish to the EventBus directly -- the caller
 * (gateway server) is responsible for that, keeping this handler pure and testable.
 *
 * Authentication supports two methods:
 *   1. Bearer token (same token as the gateway WebSocket auth)
 *   2. HMAC-SHA256 signature (per-source secret via X-Webhook-Signature header)
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const WebhookPayloadSchema = z.object({
  source: z.string().min(1).max(100),
  event: z.string().min(1).max(100),
  data: z.record(z.string(), z.unknown()),
});

export type WebhookPayload = z.infer<typeof WebhookPayloadSchema>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookDeps {
  readonly logger: Logger;
  readonly gatewayToken?: string;
  readonly webhookSecrets?: ReadonlyMap<string, string>;
}

export interface WebhookResult {
  readonly ok: true;
  readonly id: string;
  readonly payload: WebhookPayload;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum request body size: 1 MB. */
const MAX_BODY_BYTES = 1_048_576;

/** Prototype-pollution keys to strip from payloads. */
const POISON_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const JSON_CONTENT_TYPE = "application/json";

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  "Content-Type": JSON_CONTENT_TYPE,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Recursively strip prototype-pollution keys from parsed JSON payloads.
 * Handles nested objects and arrays.
 */
function sanitizePayload(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (Array.isArray(value)) {
    return value.map(sanitizePayload);
  }
  const obj = value as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!POISON_KEYS.has(key)) {
      clean[key] = sanitizePayload(obj[key]);
    }
  }
  return clean;
}

/**
 * Verify an HMAC-SHA256 signature using the Web Crypto API (crypto.subtle).
 *
 * The expected header format is: `sha256=<hex-encoded-hmac>`
 */
async function verifyHmacSignature(body: string, signature: string, secret: string): Promise<boolean> {
  if (!signature.startsWith("sha256=")) return false;
  const expectedHex = signature.slice(7);

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));

  // Convert ArrayBuffer to hex string
  const actualHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison: always compare full length
  if (expectedHex.length !== actualHex.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    mismatch |= expectedHex.charCodeAt(i) ^ actualHex.charCodeAt(i);
  }
  return mismatch === 0;
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: SECURITY_HEADERS });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle an incoming webhook HTTP request.
 *
 * Returns a Response with:
 *   - 200 + `{ ok: true, id: "..." }` on success
 *   - 400 for invalid body
 *   - 401 for authentication failure
 *   - 405 for non-POST methods
 *   - 413 for oversized bodies
 *
 * On success, the validated and sanitized payload is attached to the response
 * via the returned WebhookResult (use {@link extractWebhookResult} to get it).
 */
export async function handleWebhookRequest(req: Request, deps: WebhookDeps): Promise<Response> {
  const { logger } = deps;

  // Method check
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  // Body size check via Content-Length header (fast reject before reading)
  const contentLength = req.headers.get("Content-Length");
  if (contentLength !== null) {
    const size = parseInt(contentLength, 10);
    if (!Number.isNaN(size) && size > MAX_BODY_BYTES) {
      return jsonResponse({ ok: false, error: "Payload too large" }, 413);
    }
  }

  // Read body
  let bodyText: string;
  try {
    const bodyBuffer = await req.arrayBuffer();
    if (bodyBuffer.byteLength > MAX_BODY_BYTES) {
      return jsonResponse({ ok: false, error: "Payload too large" }, 413);
    }
    bodyText = new TextDecoder().decode(bodyBuffer);
  } catch {
    return jsonResponse({ ok: false, error: "Failed to read request body" }, 400);
  }

  // Parse JSON
  let rawBody: unknown;
  try {
    rawBody = JSON.parse(bodyText);
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
  }

  // Validate with Zod
  const parseResult = WebhookPayloadSchema.safeParse(rawBody);
  if (!parseResult.success) {
    const issues = parseResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return jsonResponse({ ok: false, error: `Validation failed: ${issues}` }, 400);
  }

  const payload = parseResult.data;

  // Authentication: Bearer token OR HMAC signature
  const authenticated = await authenticateRequest(req, bodyText, payload.source, deps);
  if (!authenticated) {
    logger.warn("webhook", "Webhook authentication failed", { source: payload.source });
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  // Sanitize data field to strip prototype-pollution keys
  const sanitizedData = sanitizePayload(payload.data) as Record<string, unknown>;
  const sanitizedPayload: WebhookPayload = {
    source: payload.source,
    event: payload.event,
    data: sanitizedData,
  };

  const id = randomUUID();

  logger.info("webhook", `Webhook received: ${payload.source}/${payload.event}`, {
    id,
    source: payload.source,
    event: payload.event,
  });

  // Attach the sanitized result for the caller to extract
  const response = jsonResponse({ ok: true, id }, 200);
  webhookResultMap.set(response, { ok: true, id, payload: sanitizedPayload });
  return response;
}

// ---------------------------------------------------------------------------
// Result extraction
// ---------------------------------------------------------------------------

/**
 * WeakMap to attach the validated webhook result to the Response object
 * without modifying the Response itself. The caller (gateway server) can
 * use {@link extractWebhookResult} to retrieve the payload for EventBus publishing.
 */
const webhookResultMap = new WeakMap<Response, WebhookResult>();

/**
 * Extract the validated and sanitized webhook result from a successful response.
 * Returns undefined if the response was not a successful webhook response.
 */
export function extractWebhookResult(response: Response): WebhookResult | undefined {
  return webhookResultMap.get(response);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function authenticateRequest(
  req: Request,
  bodyText: string,
  source: string,
  deps: WebhookDeps,
): Promise<boolean> {
  // Method 1: Bearer token
  const authHeader = req.headers.get("Authorization");
  if (authHeader !== null) {
    if (!authHeader.startsWith("Bearer ")) return false;
    const token = authHeader.slice(7);
    if (typeof deps.gatewayToken === "string" && deps.gatewayToken.length > 0) {
      return constantTimeStringCompare(token, deps.gatewayToken);
    }
    return false;
  }

  // Method 2: HMAC signature
  const signatureHeader = req.headers.get("X-Webhook-Signature");
  if (signatureHeader !== null) {
    const secret = deps.webhookSecrets?.get(source);
    if (typeof secret !== "string") return false;
    return verifyHmacSignature(bodyText, signatureHeader, secret);
  }

  // No auth headers present
  return false;
}

/**
 * Constant-time string comparison to prevent timing attacks.
 * Uses XOR comparison over character codes.
 */
function constantTimeStringCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// Export for testing
export { sanitizePayload, verifyHmacSignature };
