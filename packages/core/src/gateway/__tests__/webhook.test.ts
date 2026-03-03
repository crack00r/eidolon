import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import {
  extractWebhookResult,
  handleWebhookRequest,
  sanitizePayload,
  verifyHmacSignature,
  type WebhookDeps,
} from "../webhook.ts";

// ---------------------------------------------------------------------------
// Helpers
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

const logger = createSilentLogger();

function makeDeps(overrides?: Partial<WebhookDeps>): WebhookDeps {
  return {
    logger,
    gatewayToken: "test-secret-token",
    ...overrides,
  };
}

function makeRequest(
  body: unknown,
  options?: {
    method?: string;
    headers?: Record<string, string>;
  },
): Request {
  const method = options?.method ?? "POST";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...options?.headers,
  };

  if (method === "GET" || method === "DELETE") {
    return new Request("http://localhost/webhook", { method, headers });
  }

  return new Request("http://localhost/webhook", {
    method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validPayload(): Record<string, unknown> {
  return {
    source: "github",
    event: "push",
    data: { ref: "refs/heads/main", commits: 3 },
  };
}

/**
 * Compute an HMAC-SHA256 signature using crypto.subtle (matching the handler's verification).
 */
async function computeHmac(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("webhook handler", () => {
  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  test("accepts valid webhook with Bearer token auth", async () => {
    const deps = makeDeps();
    const req = makeRequest(validPayload(), {
      headers: { Authorization: "Bearer test-secret-token" },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe("string");
    expect((body.id as string).length).toBeGreaterThan(0);
  });

  test("accepts valid webhook with HMAC signature auth", async () => {
    const hmacSecret = "my-github-webhook-secret";
    const webhookSecrets = new Map([["github", hmacSecret]]);
    const deps = makeDeps({ webhookSecrets, gatewayToken: undefined });

    const payload = validPayload();
    const bodyStr = JSON.stringify(payload);
    const signature = await computeHmac(bodyStr, hmacSecret);

    const req = makeRequest(bodyStr, {
      headers: { "X-Webhook-Signature": signature },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  test("rejects invalid HMAC signature with 401", async () => {
    const webhookSecrets = new Map([["github", "correct-secret"]]);
    const deps = makeDeps({ webhookSecrets, gatewayToken: undefined });

    const req = makeRequest(validPayload(), {
      headers: { "X-Webhook-Signature": "sha256=deadbeef" },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(401);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Unauthorized");
  });

  test("rejects missing auth with 401", async () => {
    const deps = makeDeps();
    // No Authorization or X-Webhook-Signature header
    const req = makeRequest(validPayload());

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(401);
  });

  test("rejects invalid Bearer token with 401", async () => {
    const deps = makeDeps({ gatewayToken: "correct-token" });
    const req = makeRequest(validPayload(), {
      headers: { Authorization: "Bearer wrong-token" },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(401);
  });

  test("rejects HMAC when source has no configured secret", async () => {
    const webhookSecrets = new Map([["gitlab", "some-secret"]]);
    const deps = makeDeps({ webhookSecrets, gatewayToken: undefined });

    const req = makeRequest(validPayload(), {
      headers: { "X-Webhook-Signature": "sha256=anything" },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  test("rejects invalid body with missing required fields (400)", async () => {
    const deps = makeDeps();
    const req = makeRequest(
      { source: "github" }, // missing event and data
      { headers: { Authorization: "Bearer test-secret-token" } },
    );

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect((body.error as string).includes("Validation failed")).toBe(true);
  });

  test("rejects non-JSON body with 400", async () => {
    const deps = makeDeps();
    const req = makeRequest("not json at all", {
      headers: { Authorization: "Bearer test-secret-token" },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(400);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("Invalid JSON");
  });

  test("rejects empty source string with 400", async () => {
    const deps = makeDeps();
    const req = makeRequest(
      { source: "", event: "push", data: {} },
      { headers: { Authorization: "Bearer test-secret-token" } },
    );

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Method enforcement
  // -------------------------------------------------------------------------

  test("rejects non-POST method with 405", async () => {
    const deps = makeDeps();
    const req = makeRequest(null, {
      method: "GET",
      headers: { Authorization: "Bearer test-secret-token" },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(405);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Method not allowed");
  });

  // -------------------------------------------------------------------------
  // Body size limit
  // -------------------------------------------------------------------------

  test("rejects body > 1MB with 413", async () => {
    const deps = makeDeps();
    // Create a payload with a data field exceeding 1MB
    const largeData: Record<string, unknown> = {};
    largeData.huge = "x".repeat(1_100_000);
    const body = JSON.stringify({ source: "test", event: "big", data: largeData });

    const req = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-secret-token",
        "Content-Length": String(body.length),
      },
      body,
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(413);
  });

  // -------------------------------------------------------------------------
  // Payload sanitization
  // -------------------------------------------------------------------------

  test("sanitizes prototype pollution keys from data", async () => {
    const deps = makeDeps();
    const poisonedPayload = {
      source: "ci",
      event: "build",
      data: {
        status: "success",
        __proto__: { admin: true },
        nested: {
          constructor: "evil",
          value: 42,
        },
      },
    };

    const req = makeRequest(poisonedPayload, {
      headers: { Authorization: "Bearer test-secret-token" },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(200);

    const result = extractWebhookResult(res);
    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);

    // Verify poison keys are stripped (use Object.hasOwn, not `in`, since `in` checks the prototype chain)
    const data = result?.payload.data;
    expect(data).toBeDefined();
    expect(Object.hasOwn(data ?? {}, "__proto__")).toBe(false);
    expect((data as Record<string, unknown>).status).toBe("success");

    const nested = (data as Record<string, unknown>).nested as Record<string, unknown>;
    expect(Object.hasOwn(nested, "constructor")).toBe(false);
    expect(nested.value).toBe(42);
  });

  // -------------------------------------------------------------------------
  // Response format
  // -------------------------------------------------------------------------

  test("returns valid response format with id", async () => {
    const deps = makeDeps();
    const req = makeRequest(validPayload(), {
      headers: { Authorization: "Bearer test-secret-token" },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("ok", true);
    expect(body).toHaveProperty("id");
    expect(typeof body.id).toBe("string");
    // Verify it looks like a UUID
    expect(body.id as string).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("extractWebhookResult returns payload for successful response", async () => {
    const deps = makeDeps();
    const payload = validPayload();
    const req = makeRequest(payload, {
      headers: { Authorization: "Bearer test-secret-token" },
    });

    const res = await handleWebhookRequest(req, deps);
    const result = extractWebhookResult(res);

    expect(result).toBeDefined();
    expect(result?.ok).toBe(true);
    expect(result?.payload.source).toBe("github");
    expect(result?.payload.event).toBe("push");
    expect(result?.payload.data).toEqual({ ref: "refs/heads/main", commits: 3 });
  });

  test("extractWebhookResult returns undefined for error response", async () => {
    const deps = makeDeps();
    const req = makeRequest(null, {
      method: "GET",
      headers: { Authorization: "Bearer test-secret-token" },
    });

    const res = await handleWebhookRequest(req, deps);
    const result = extractWebhookResult(res);
    expect(result).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Security headers
  // -------------------------------------------------------------------------

  test("includes security headers in all responses", async () => {
    const deps = makeDeps();
    const req = makeRequest(validPayload(), {
      headers: { Authorization: "Bearer test-secret-token" },
    });

    const res = await handleWebhookRequest(req, deps);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Type")).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Unit tests for sanitizePayload
// ---------------------------------------------------------------------------

describe("sanitizePayload", () => {
  test("strips __proto__ key", () => {
    // Use Object.create(null) to set __proto__ as an own property
    const obj = Object.create(null) as Record<string, unknown>;
    obj.a = 1;
    obj.__proto__ = { admin: true };

    const result = sanitizePayload(obj) as Record<string, unknown>;
    // Use Object.hasOwn since `in` checks prototype chain (which has __proto__ on normal objects)
    expect(Object.hasOwn(result, "__proto__")).toBe(false);
    expect(result.a).toBe(1);
  });

  test("strips constructor and prototype keys", () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj["constructor"] = "Foo";
    obj["prototype"] = {};
    obj["safe"] = "value";

    const result = sanitizePayload(obj) as Record<string, unknown>;
    expect(Object.hasOwn(result, "constructor")).toBe(false);
    expect(Object.hasOwn(result, "prototype")).toBe(false);
    expect(result.safe).toBe("value");
  });

  test("handles nested objects recursively", () => {
    const nested = Object.create(null) as Record<string, unknown>;
    nested.__proto__ = "bad";
    nested.good = "value";

    const obj = Object.create(null) as Record<string, unknown>;
    obj.nested = nested;

    const result = sanitizePayload(obj) as Record<string, unknown>;
    const resultNested = result.nested as Record<string, unknown>;
    expect(Object.hasOwn(resultNested, "__proto__")).toBe(false);
    expect(resultNested.good).toBe("value");
  });

  test("handles arrays", () => {
    const item = Object.create(null) as Record<string, unknown>;
    item.__proto__ = "bad";
    item.value = 1;

    const result = sanitizePayload([item, "hello", 42]) as unknown[];
    expect(result).toHaveLength(3);
    expect(Object.hasOwn(result[0] as Record<string, unknown>, "__proto__")).toBe(false);
    expect((result[0] as Record<string, unknown>).value).toBe(1);
    expect(result[1]).toBe("hello");
    expect(result[2]).toBe(42);
  });

  test("passes through primitives unchanged", () => {
    expect(sanitizePayload("hello")).toBe("hello");
    expect(sanitizePayload(42)).toBe(42);
    expect(sanitizePayload(null)).toBe(null);
    expect(sanitizePayload(true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit tests for verifyHmacSignature
// ---------------------------------------------------------------------------

describe("verifyHmacSignature", () => {
  test("returns true for valid signature", async () => {
    const body = '{"source":"test","event":"ping","data":{}}';
    const secret = "webhook-secret-123";
    const signature = await computeHmac(body, secret);

    const result = await verifyHmacSignature(body, signature, secret);
    expect(result).toBe(true);
  });

  test("returns false for invalid signature", async () => {
    const body = '{"source":"test","event":"ping","data":{}}';
    const result = await verifyHmacSignature(
      body,
      "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      "secret",
    );
    expect(result).toBe(false);
  });

  test("returns false for missing sha256= prefix", async () => {
    const result = await verifyHmacSignature("body", "invalid-format", "secret");
    expect(result).toBe(false);
  });
});
