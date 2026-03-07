/**
 * Tests for TelegramChannel internals: authorization, rate limiting,
 * inbound message truncation, retry logic, and fatal error detection.
 *
 * These tests complement the existing e2e-flow.test.ts which covers
 * channel properties, lifecycle, formatter, splitMessage, media utils.
 */

import { describe, expect, test } from "bun:test";
import { GrammyError, HttpError } from "grammy";
import type { Logger } from "../../../logging/logger.ts";
import type { TelegramConfig } from "../channel.ts";
import { TelegramChannel } from "../channel.ts";
import { isFatalBotError, sendWithRetry } from "../channel-retry.ts";

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

function createTestConfig(overrides?: Partial<TelegramConfig>): TelegramConfig {
  return {
    botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
    allowedUserIds: [111111, 222222],
    typingIndicator: true,
    ...overrides,
  };
}

function makeChannel(overrides?: Partial<TelegramConfig>): TelegramChannel {
  return new TelegramChannel(createTestConfig(overrides), createSilentLogger());
}

/**
 * Create a GrammyError with a given status code and description.
 * GrammyError constructor: (message, error_code, description, method, payload)
 * But the actual constructor signature is (message, err).
 * We construct it to match the real shape.
 */
function createGrammyError(code: number, description: string): GrammyError {
  const payload = {
    ok: false as const,
    error_code: code,
    description,
  };
  return new GrammyError(`Telegram API error (${code})`, payload, "sendMessage", {});
}

function _createGrammyError429(retryAfter: number): GrammyError & { parameters?: { retry_after?: number } } {
  const payload = {
    ok: false as const,
    error_code: 429,
    description: `Too Many Requests: retry after ${retryAfter}`,
    parameters: { retry_after: retryAfter },
  };
  const err = new GrammyError("Telegram API error (429)", payload, "sendMessage", {});
  // GrammyError stores parameters on the instance
  (err as any).parameters = { retry_after: retryAfter };
  return err as GrammyError & { parameters?: { retry_after?: number } };
}

// ---------------------------------------------------------------------------
// Authorization (isAuthorized)
// ---------------------------------------------------------------------------

describe("TelegramChannel authorization", () => {
  test("allows user in allowedUserIds", () => {
    const channel = makeChannel({ allowedUserIds: [111111, 222222] });
    expect((channel as any).isAuthorized(111111)).toBe(true);
    expect((channel as any).isAuthorized(222222)).toBe(true);
  });

  test("denies user not in allowedUserIds", () => {
    const channel = makeChannel({ allowedUserIds: [111111] });
    expect((channel as any).isAuthorized(999999)).toBe(false);
  });

  test("denies undefined userId", () => {
    const channel = makeChannel();
    expect((channel as any).isAuthorized(undefined)).toBe(false);
  });

  test("works with empty allowedUserIds", () => {
    const channel = makeChannel({ allowedUserIds: [] });
    expect((channel as any).isAuthorized(111111)).toBe(false);
  });

  test("handles single allowed user", () => {
    const channel = makeChannel({ allowedUserIds: [42] });
    expect((channel as any).isAuthorized(42)).toBe(true);
    expect((channel as any).isAuthorized(43)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting (isRateLimited)
// ---------------------------------------------------------------------------

describe("TelegramChannel rate limiting", () => {
  test("allows first message from a user", () => {
    const channel = makeChannel();
    expect((channel as any).isRateLimited(111111)).toBe(false);
  });

  test("allows up to 30 messages within window", () => {
    const channel = makeChannel();
    const userId = 111111;

    for (let i = 0; i < 30; i++) {
      expect((channel as any).isRateLimited(userId)).toBe(false);
    }
  });

  test("blocks the 31st message within window", () => {
    const channel = makeChannel();
    const userId = 111111;

    // First 30 messages pass
    for (let i = 0; i < 30; i++) {
      (channel as any).isRateLimited(userId);
    }

    // 31st message is rate limited
    expect((channel as any).isRateLimited(userId)).toBe(true);
  });

  test("continues blocking after limit reached", () => {
    const channel = makeChannel();
    const userId = 111111;

    for (let i = 0; i < 30; i++) {
      (channel as any).isRateLimited(userId);
    }

    // Messages 31-35 are all blocked
    for (let i = 0; i < 5; i++) {
      expect((channel as any).isRateLimited(userId)).toBe(true);
    }
  });

  test("tracks different users independently", () => {
    const channel = makeChannel();

    // Fill up user A's limit
    for (let i = 0; i < 30; i++) {
      (channel as any).isRateLimited(100);
    }
    expect((channel as any).isRateLimited(100)).toBe(true);

    // User B should still be allowed
    expect((channel as any).isRateLimited(200)).toBe(false);
  });

  test("resets after window expires", () => {
    const channel = makeChannel();
    const userId = 111111;

    // Fill up the limit
    for (let i = 0; i < 30; i++) {
      (channel as any).isRateLimited(userId);
    }
    expect((channel as any).isRateLimited(userId)).toBe(true);

    // Manually expire the window by modifying windowStart
    const rateLimits: Map<number, { count: number; windowStart: number }> = (channel as any).userRateLimits;
    const entry = rateLimits.get(userId)!;
    entry.windowStart = Date.now() - 61_000; // Move window start to > 60s ago

    // Should be allowed again (window expired)
    expect((channel as any).isRateLimited(userId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inbound message construction and truncation (toInboundMessage)
// ---------------------------------------------------------------------------

describe("TelegramChannel toInboundMessage", () => {
  test("creates message with all fields", () => {
    const channel = makeChannel();
    const msg = (channel as any).toInboundMessage("123", "456", "789", "Hello world", "100");

    expect(msg.channelId).toBe("456");
    expect(msg.userId).toBe("789");
    expect(msg.text).toBe("Hello world");
    expect(msg.replyToId).toBe("100");
    expect(msg.id).toMatch(/^tg-123-/);
    expect(typeof msg.timestamp).toBe("number");
  });

  test("creates message without optional fields", () => {
    const channel = makeChannel();
    const msg = (channel as any).toInboundMessage("123", "456", "789");

    expect(msg.channelId).toBe("456");
    expect(msg.userId).toBe("789");
    expect(msg.text).toBeUndefined();
    expect(msg.replyToId).toBeUndefined();
    expect(msg.attachments).toBeUndefined();
  });

  test("truncates text exceeding 100,000 characters", () => {
    const channel = makeChannel();
    const longText = "x".repeat(150_000);
    const msg = (channel as any).toInboundMessage("1", "2", "3", longText);

    expect(msg.text!.length).toBe(100_000);
  });

  test("preserves text at exactly 100,000 characters", () => {
    const channel = makeChannel();
    const exactText = "y".repeat(100_000);
    const msg = (channel as any).toInboundMessage("1", "2", "3", exactText);

    expect(msg.text!.length).toBe(100_000);
    expect(msg.text).toBe(exactText);
  });

  test("preserves short text without truncation", () => {
    const channel = makeChannel();
    const msg = (channel as any).toInboundMessage("1", "2", "3", "short");

    expect(msg.text).toBe("short");
  });

  test("handles undefined text (voice-only messages)", () => {
    const channel = makeChannel();
    const msg = (channel as any).toInboundMessage("1", "2", "3", undefined);

    expect(msg.text).toBeUndefined();
  });

  test("includes attachments when provided", () => {
    const channel = makeChannel();
    const attachments = [{ type: "image" as const, mimeType: "image/png", size: 100 }];
    const msg = (channel as any).toInboundMessage("1", "2", "3", "photo", undefined, attachments);

    expect(msg.attachments).toHaveLength(1);
    expect(msg.attachments![0].type).toBe("image");
  });

  test("generates unique IDs for each message", () => {
    const channel = makeChannel();
    const msg1 = (channel as any).toInboundMessage("1", "2", "3", "a");
    const msg2 = (channel as any).toInboundMessage("1", "2", "3", "b");

    // Both start with tg-1- but have different UUID suffixes
    expect(msg1.id).not.toBe(msg2.id);
    expect(msg1.id).toMatch(/^tg-1-/);
    expect(msg2.id).toMatch(/^tg-1-/);
  });
});

// ---------------------------------------------------------------------------
// Fatal error detection (isFatalBotError)
// ---------------------------------------------------------------------------

describe("TelegramChannel isFatalBotError", () => {
  test("detects 401 Unauthorized as fatal", () => {
    const err = createGrammyError(401, "Unauthorized");
    expect(isFatalBotError(err)).toBe(true);
  });

  test("detects 'unauthorized' description pattern as fatal", () => {
    const err = createGrammyError(403, "Forbidden: bot was blocked by the user - Unauthorized request");
    expect(isFatalBotError(err)).toBe(true);
  });

  test("detects 'bot was blocked' pattern as fatal", () => {
    const err = createGrammyError(403, "Forbidden: bot was blocked by the user");
    expect(isFatalBotError(err)).toBe(true);
  });

  test("detects 'bot was kicked' pattern as fatal", () => {
    const err = createGrammyError(403, "Forbidden: bot was kicked from the group chat");
    expect(isFatalBotError(err)).toBe(true);
  });

  test("detects 'not found' pattern as fatal", () => {
    const err = createGrammyError(404, "Not Found");
    expect(isFatalBotError(err)).toBe(true);
  });

  test("does not treat 429 as fatal", () => {
    const err = createGrammyError(429, "Too Many Requests: retry after 10");
    expect(isFatalBotError(err)).toBe(false);
  });

  test("does not treat 500 as fatal", () => {
    const err = createGrammyError(500, "Internal Server Error");
    expect(isFatalBotError(err)).toBe(false);
  });

  test("does not treat 502 as fatal", () => {
    const err = createGrammyError(502, "Bad Gateway");
    expect(isFatalBotError(err)).toBe(false);
  });

  test("does not treat non-GrammyError as fatal", () => {
    expect(isFatalBotError(new Error("network failure"))).toBe(false);
  });

  test("does not treat plain string as fatal", () => {
    expect(isFatalBotError("something")).toBe(false);
  });

  test("does not treat null as fatal", () => {
    expect(isFatalBotError(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// sendWithRetry
// ---------------------------------------------------------------------------

describe("TelegramChannel sendWithRetry", () => {
  const logger = createSilentLogger();

  test("returns result on first success", async () => {
    const result = await sendWithRetry(() => Promise.resolve("ok"), logger);
    expect(result).toBe("ok");
  });

  test("throws fatal errors immediately without retry", async () => {
    const fatalErr = createGrammyError(401, "Unauthorized");
    let callCount = 0;

    try {
      await sendWithRetry(() => {
        callCount++;
        throw fatalErr;
      }, logger);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBe(fatalErr);
      expect(callCount).toBe(1); // No retries
    }
  });

  test("throws non-retryable GrammyError (4xx) immediately", async () => {
    const err = createGrammyError(400, "Bad Request: message is too long");
    let callCount = 0;

    try {
      await sendWithRetry(() => {
        callCount++;
        throw err;
      }, logger);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBe(err);
      expect(callCount).toBe(1);
    }
  });

  test("retries on HttpError up to MAX_RETRIES", async () => {
    let callCount = 0;

    try {
      await sendWithRetry(() => {
        callCount++;
        throw new HttpError("Network error", 0);
      }, logger);
      expect.unreachable("should have thrown");
    } catch {
      // MAX_RETRIES = 3, so total attempts = 4 (initial + 3 retries)
      expect(callCount).toBe(4);
    }
  }, 15_000); // Allow time for retry delays

  test("retries on 429 GrammyError", async () => {
    let callCount = 0;

    try {
      await sendWithRetry(() => {
        callCount++;
        throw createGrammyError(429, "Too Many Requests: retry after 1");
      }, logger);
      expect.unreachable("should have thrown");
    } catch {
      expect(callCount).toBe(4); // initial + 3 retries
    }
  }, 15_000);

  test("retries on 500 GrammyError", async () => {
    let callCount = 0;

    try {
      await sendWithRetry(() => {
        callCount++;
        throw createGrammyError(500, "Internal Server Error");
      }, logger);
      expect.unreachable("should have thrown");
    } catch {
      expect(callCount).toBe(4);
    }
  }, 15_000);

  test("succeeds on retry after transient failure", async () => {
    let callCount = 0;

    const result = await sendWithRetry(() => {
      callCount++;
      if (callCount === 1) {
        throw new HttpError("Network error", 0);
      }
      return Promise.resolve("recovered");
    }, logger);

    expect(result).toBe("recovered");
    expect(callCount).toBe(2);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// dispatchMessage
// ---------------------------------------------------------------------------

describe("TelegramChannel dispatchMessage", () => {
  test("calls registered handler with message", async () => {
    const channel = makeChannel();
    const received: any[] = [];
    channel.onMessage(async (msg) => {
      received.push(msg);
    });

    const testMsg = (channel as any).toInboundMessage("1", "chat1", "user1", "hello");
    await (channel as any).dispatchMessage(testMsg);

    expect(received).toHaveLength(1);
    expect(received[0].text).toBe("hello");
  });

  test("does not throw when no handler is registered", async () => {
    const channel = makeChannel();
    const testMsg = (channel as any).toInboundMessage("1", "chat1", "user1", "hello");

    // Should not throw
    await (channel as any).dispatchMessage(testMsg);
  });

  test("catches and logs handler errors", async () => {
    const channel = makeChannel();
    channel.onMessage(async () => {
      throw new Error("handler crash");
    });

    const testMsg = (channel as any).toInboundMessage("1", "chat1", "user1", "hello");

    // Should not throw even though handler throws
    await (channel as any).dispatchMessage(testMsg);
  });
});
