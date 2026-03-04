import { describe, expect, test } from "bun:test";
import type { WhatsAppApiConfig } from "../api.ts";
import { WhatsAppCloudApi } from "../api.ts";
import type { Logger } from "../../../logging/logger.ts";

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

function createTestConfig(): WhatsAppApiConfig {
  return {
    phoneNumberId: "123456789",
    accessToken: "test-access-token",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Note: WhatsAppCloudApi makes real HTTP requests to graph.facebook.com.
 * These tests verify the class structure and construction, not actual API calls.
 * Full integration testing would require a mock HTTP server or the FakeWhatsAppApi
 * (which is used in channel.test.ts).
 *
 * The WhatsAppApiClient interface is the primary testing seam -- all channel
 * logic is tested against FakeWhatsAppApi in channel.test.ts.
 */
describe("WhatsAppCloudApi", () => {
  test("can be constructed with valid config", () => {
    const config = createTestConfig();
    const logger = createSilentLogger();
    const api = new WhatsAppCloudApi(config, logger);

    // Verify the instance was created (no exceptions)
    expect(api).toBeDefined();
  });

  test("implements WhatsAppApiClient interface methods", () => {
    const config = createTestConfig();
    const logger = createSilentLogger();
    const api = new WhatsAppCloudApi(config, logger);

    // Verify all interface methods exist
    expect(typeof api.sendText).toBe("function");
    expect(typeof api.sendMedia).toBe("function");
    expect(typeof api.markAsRead).toBe("function");
    expect(typeof api.downloadMedia).toBe("function");
  });

  test("sendText returns an error for unreachable API", async () => {
    // This test exercises the error handling path.
    // The real API is unreachable in test, so we expect a network error result.
    const config = createTestConfig();
    const logger = createSilentLogger();
    const api = new WhatsAppCloudApi(config, logger);

    // We cannot actually hit graph.facebook.com in tests,
    // but we can verify the Result pattern is used correctly.
    // A network failure should return Err, not throw.
    const result = await api.sendText("+491234567890", "Hello");

    // Should be an error result (network failure), not a thrown exception
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WHATSAPP_API_ERROR");
    }
  });

  test("markAsRead returns an error for unreachable API", async () => {
    const config = createTestConfig();
    const logger = createSilentLogger();
    const api = new WhatsAppCloudApi(config, logger);

    const result = await api.markAsRead("wamid.test123");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WHATSAPP_API_ERROR");
    }
  });

  test("downloadMedia returns an error for unreachable API", async () => {
    const config = createTestConfig();
    const logger = createSilentLogger();
    const api = new WhatsAppCloudApi(config, logger);

    const result = await api.downloadMedia("media-id-123");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WHATSAPP_API_ERROR");
    }
  });
});
