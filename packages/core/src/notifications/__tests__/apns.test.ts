/**
 * Tests for ApnsClient.
 *
 * Mocks HTTP/2 calls and verifies payload construction, error handling,
 * device token management, and retry behavior.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import type { ApnsConfig, ApnsPayload } from "../apns.ts";
import { ApnsClient } from "../apns.ts";

// ---------------------------------------------------------------------------
// Test Helpers
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

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE device_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      platform TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX idx_device_tokens_platform ON device_tokens(platform);
  `);
  return db;
}

/** Pre-generated EC P-256 (prime256v1) private key for test use only. */
function getTestPrivateKey(): string {
  return `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIFZ4JcekpdMf3BQNUE96fgtlBhWagx6+9LPVbixkPLr5oAoGCCqGSM49
AwEHoUQDQgAE91sKtlTz+7ZmSzYgUZ3G7RRMsT7tOcP7MpyAE5ojIETJrPP55Hkd
ddcPiUggmIznyrWSUGQrmO7RfhK8yEDTvA==
-----END EC PRIVATE KEY-----`;
}

function createTestConfig(overrides?: Partial<ApnsConfig>): ApnsConfig {
  return {
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKey: getTestPrivateKey(),
    bundleId: "com.eidolon.app",
    sandbox: true,
    ...overrides,
  };
}

const TEST_DEVICE_TOKEN = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

function createTestPayload(overrides?: Partial<ApnsPayload>): ApnsPayload {
  return {
    alert: {
      title: "Test Notification",
      body: "This is a test message",
    },
    ...overrides,
  };
}

/**
 * Inject mocks for both getJwt and sendRequest on an ApnsClient instance.
 * This bypasses JWT generation (which needs a real key) and HTTP/2 (which needs a server).
 */
function mockClientInternals(
  client: ApnsClient,
  sendRequestResult: () => Promise<
    { ok: true; value: undefined } | { ok: false; error: { code: string; message: string; timestamp: number } }
  >,
): void {
  const clientRec = client as unknown as Record<string, unknown>;
  clientRec.getJwt = () => ({ ok: true, value: "mock-jwt-token" });
  clientRec.sendRequest = mock(sendRequestResult);
}

// ---------------------------------------------------------------------------
// Device Token Management Tests
// ---------------------------------------------------------------------------

describe("ApnsClient - Device Token Management", () => {
  let db: Database;
  let client: ApnsClient;

  beforeEach(() => {
    db = createTestDb();
    client = new ApnsClient(createTestConfig(), db, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  test("registerDeviceToken stores a new token", () => {
    const result = client.registerDeviceToken(TEST_DEVICE_TOKEN, "ios");
    expect(result.ok).toBe(true);

    const row = db.query("SELECT * FROM device_tokens WHERE token = ?").get(TEST_DEVICE_TOKEN) as Record<
      string,
      unknown
    > | null;
    expect(row).not.toBeNull();
    expect(row?.platform).toBe("ios");
    expect(typeof row?.created_at).toBe("number");
  });

  test("registerDeviceToken updates last_used_at on duplicate", () => {
    client.registerDeviceToken(TEST_DEVICE_TOKEN, "ios");

    const row1 = db.query("SELECT last_used_at FROM device_tokens WHERE token = ?").get(TEST_DEVICE_TOKEN) as {
      last_used_at: number;
    } | null;

    // Register again
    const result = client.registerDeviceToken(TEST_DEVICE_TOKEN, "ios");
    expect(result.ok).toBe(true);

    const row2 = db.query("SELECT last_used_at FROM device_tokens WHERE token = ?").get(TEST_DEVICE_TOKEN) as {
      last_used_at: number;
    } | null;

    // Should have only 1 row
    const count = db.query("SELECT COUNT(*) as count FROM device_tokens").get() as { count: number };
    expect(count.count).toBe(1);

    // last_used_at should be >= the first insert
    expect(row2?.last_used_at).toBeGreaterThanOrEqual(row1?.last_used_at ?? 0);
  });

  test("unregisterDeviceToken removes the token", () => {
    client.registerDeviceToken(TEST_DEVICE_TOKEN, "ios");
    const result = client.unregisterDeviceToken(TEST_DEVICE_TOKEN);
    expect(result.ok).toBe(true);

    const row = db.query("SELECT * FROM device_tokens WHERE token = ?").get(TEST_DEVICE_TOKEN);
    expect(row).toBeNull();
  });

  test("unregisterDeviceToken succeeds for non-existent token", () => {
    const result = client.unregisterDeviceToken("nonexistent");
    expect(result.ok).toBe(true);
  });

  test("getDeviceTokens returns all tokens", () => {
    const token1 = "1111111111111111111111111111111111111111111111111111111111111111";
    const token2 = "2222222222222222222222222222222222222222222222222222222222222222";
    const token3 = "3333333333333333333333333333333333333333333333333333333333333333";
    client.registerDeviceToken(token1, "ios");
    client.registerDeviceToken(token2, "ios");
    client.registerDeviceToken(token3, "macos");

    const result = client.getDeviceTokens();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(3);
    }
  });

  test("getDeviceTokens filters by platform", () => {
    const token1 = "1111111111111111111111111111111111111111111111111111111111111111";
    const token2 = "2222222222222222222222222222222222222222222222222222222222222222";
    const token3 = "3333333333333333333333333333333333333333333333333333333333333333";
    client.registerDeviceToken(token1, "ios");
    client.registerDeviceToken(token2, "ios");
    client.registerDeviceToken(token3, "macos");

    const result = client.getDeviceTokens("ios");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value).toContain(token1);
      expect(result.value).toContain(token2);
    }
  });

  test("registerDeviceToken rejects invalid token format", () => {
    const result = client.registerDeviceToken("invalid-token", "ios");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("64-character hex string");
    }
  });

  test("registerDeviceToken rejects token with non-hex characters", () => {
    const result = client.registerDeviceToken(
      "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
      "ios",
    );
    expect(result.ok).toBe(false);
  });

  test("getDeviceTokens returns empty array when no tokens", () => {
    const result = client.getDeviceTokens();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Payload Construction Tests
// ---------------------------------------------------------------------------

describe("ApnsClient - Payload Construction", () => {
  let db: Database;

  afterEach(() => {
    db.close();
  });

  test("buildApnsPayload constructs correct structure via mocked send", async () => {
    db = createTestDb();
    const client = new ApnsClient(createTestConfig(), db, createSilentLogger());

    // Capture the body passed to sendRequest
    let capturedBody = "";
    const clientRec = client as unknown as Record<string, unknown>;
    clientRec.getJwt = () => ({ ok: true, value: "mock-jwt" });
    clientRec.sendRequest = mock((_token: string, body: string) => {
      capturedBody = body;
      return Promise.resolve({ ok: true, value: undefined });
    });

    await client.sendPushNotification(TEST_DEVICE_TOKEN, createTestPayload());

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    const aps = parsed.aps as Record<string, unknown>;
    const alert = aps.alert as Record<string, unknown>;

    expect(alert.title).toBe("Test Notification");
    expect(alert.body).toBe("This is a test message");
    expect(aps.sound).toBe("default");
  });

  test("buildApnsPayload includes optional fields", async () => {
    db = createTestDb();
    const client = new ApnsClient(createTestConfig(), db, createSilentLogger());

    let capturedBody = "";
    const clientRec = client as unknown as Record<string, unknown>;
    clientRec.getJwt = () => ({ ok: true, value: "mock-jwt" });
    clientRec.sendRequest = mock((_token: string, body: string) => {
      capturedBody = body;
      return Promise.resolve({ ok: true, value: undefined });
    });

    await client.sendPushNotification(
      TEST_DEVICE_TOKEN,
      createTestPayload({
        badge: 5,
        sound: "custom.aiff",
        data: { conversationId: "conv-123" },
      }),
    );

    const parsed = JSON.parse(capturedBody) as Record<string, unknown>;
    const aps = parsed.aps as Record<string, unknown>;

    expect(aps.badge).toBe(5);
    expect(aps.sound).toBe("custom.aiff");
    expect(parsed.conversationId).toBe("conv-123");
  });
});

// ---------------------------------------------------------------------------
// Error Handling Tests (mocked HTTP/2)
// ---------------------------------------------------------------------------

describe("ApnsClient - Error Handling", () => {
  let db: Database;
  let client: ApnsClient;

  beforeEach(() => {
    db = createTestDb();
    client = new ApnsClient(createTestConfig({ retryDelayMs: 0 }), db, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  test("sendPushNotification returns error for 400 bad request", async () => {
    mockClientInternals(client, () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: "APNS_SEND_FAILED" as const,
          message: "APNs bad request (400): BadDeviceToken",
          timestamp: Date.now(),
        },
      }),
    );

    const result = await client.sendPushNotification(TEST_DEVICE_TOKEN, createTestPayload());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("APNS_SEND_FAILED");
      expect(result.error.message).toContain("400");
    }
  });

  test("sendPushNotification returns error for 403 auth failure", async () => {
    mockClientInternals(client, () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: "APNS_AUTH_FAILED" as const,
          message: "APNs authentication failed (403): InvalidProviderToken",
          timestamp: Date.now(),
        },
      }),
    );

    const result = await client.sendPushNotification(TEST_DEVICE_TOKEN, createTestPayload());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("APNS_AUTH_FAILED");
    }
  });

  test("sendPushNotification auto-removes token on 410 response", async () => {
    // Register the token first
    client.registerDeviceToken(TEST_DEVICE_TOKEN, "ios");

    mockClientInternals(client, () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: "APNS_DEVICE_UNREGISTERED" as const,
          message: "Device token unregistered (410): Unregistered",
          timestamp: Date.now(),
        },
      }),
    );

    const result = await client.sendPushNotification(TEST_DEVICE_TOKEN, createTestPayload());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("APNS_DEVICE_UNREGISTERED");
    }

    // Token should have been auto-removed
    const row = db.query("SELECT * FROM device_tokens WHERE token = ?").get(TEST_DEVICE_TOKEN);
    expect(row).toBeNull();
  });

  test("sendPushNotification retries on 429 rate limit", async () => {
    let callCount = 0;
    const clientRec = client as unknown as Record<string, unknown>;
    clientRec.getJwt = () => ({ ok: true, value: "mock-jwt-token" });
    clientRec.sendRequest = mock(() => {
      callCount++;
      if (callCount <= 2) {
        return Promise.resolve({
          ok: false as const,
          error: {
            code: "APNS_RATE_LIMITED" as const,
            message: "APNs rate limited (429): TooManyRequests",
            timestamp: Date.now(),
          },
        });
      }
      return Promise.resolve({ ok: true as const, value: undefined });
    });

    const result = await client.sendPushNotification(TEST_DEVICE_TOKEN, createTestPayload());
    // After retrying, the 3rd call succeeds
    expect(result.ok).toBe(true);
    expect(callCount).toBe(3);
  });

  test("sendPushNotification fails after max retries on persistent 429", async () => {
    mockClientInternals(client, () =>
      Promise.resolve({
        ok: false as const,
        error: {
          code: "APNS_RATE_LIMITED" as const,
          message: "APNs rate limited (429): TooManyRequests",
          timestamp: Date.now(),
        },
      }),
    );

    const result = await client.sendPushNotification(TEST_DEVICE_TOKEN, createTestPayload());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // After MAX_RETRIES+1 attempts, should return the last error
      expect(["APNS_RATE_LIMITED", "APNS_SEND_FAILED"]).toContain(result.error.code);
    }
  });

  test("sendPushNotification returns success for 200 response", async () => {
    client.registerDeviceToken(TEST_DEVICE_TOKEN, "ios");

    mockClientInternals(client, () => Promise.resolve({ ok: true as const, value: undefined }));

    const result = await client.sendPushNotification(TEST_DEVICE_TOKEN, createTestPayload());
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JWT Generation Tests
// ---------------------------------------------------------------------------

describe("ApnsClient - JWT Generation", () => {
  let db: Database;

  afterEach(() => {
    db.close();
  });

  test("getJwt generates a valid JWT structure", () => {
    db = createTestDb();
    const client = new ApnsClient(createTestConfig(), db, createSilentLogger());

    // Access the private getJwt method for testing
    const getJwt = (client as unknown as Record<string, unknown>).getJwt as () => {
      ok: boolean;
      value?: string;
      error?: unknown;
    };
    const result = getJwt.call(client);

    expect(result.ok).toBe(true);
    if (result.ok && result.value) {
      const parts = result.value.split(".");
      expect(parts).toHaveLength(3);

      // Verify header
      const header = JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf-8")) as Record<string, unknown>;
      expect(header.alg).toBe("ES256");
      expect(header.kid).toBe("KEY1234567");

      // Verify claims
      const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf-8")) as Record<string, unknown>;
      expect(claims.iss).toBe("TEAM123456");
      expect(typeof claims.iat).toBe("number");
    }
  });

  test("getJwt caches token on subsequent calls", () => {
    db = createTestDb();
    const client = new ApnsClient(createTestConfig(), db, createSilentLogger());

    const getJwt = (client as unknown as Record<string, unknown>).getJwt as () => { ok: boolean; value?: string };
    const result1 = getJwt.call(client);
    const result2 = getJwt.call(client);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      // Same token should be returned (cached)
      expect(result1.value).toBe(result2.value);
    }
  });

  test("getJwt returns error for invalid private key", () => {
    db = createTestDb();
    const client = new ApnsClient(createTestConfig({ privateKey: "invalid-key" }), db, createSilentLogger());

    const getJwt = (client as unknown as Record<string, unknown>).getJwt as () => {
      ok: boolean;
      error?: { code: string };
    };
    const result = getJwt.call(client);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error) {
      expect(result.error.code).toBe("APNS_AUTH_FAILED");
    }
  });
});
