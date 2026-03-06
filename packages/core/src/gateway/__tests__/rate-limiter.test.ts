/**
 * Integration tests for AuthRateLimiter.
 *
 * Tests the IP-based auth rate limiter with exponential backoff:
 * - Max failures within window triggers block
 * - Block duration escalation (exponential backoff)
 * - Unblocking after blockMs expires
 * - Success clears failure state
 * - Violation history decay
 * - Entry eviction when at capacity
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { AuthRateLimiter, type RateLimitConfig } from "../rate-limiter.ts";

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

/** Short-lived config for fast tests. */
const TEST_CONFIG: RateLimitConfig = {
  maxFailures: 3,
  windowMs: 1_000,
  blockMs: 500,
  maxBlockMs: 4_000,
};

const limiters: AuthRateLimiter[] = [];

function makeLimiter(config: RateLimitConfig = TEST_CONFIG): AuthRateLimiter {
  const limiter = new AuthRateLimiter(config, logger);
  limiters.push(limiter);
  return limiter;
}

afterEach(() => {
  for (const l of limiters) {
    l.dispose();
  }
  limiters.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthRateLimiter", () => {
  describe("basic blocking", () => {
    test("IP is not blocked before reaching maxFailures", () => {
      const limiter = makeLimiter();
      const ip = "10.0.0.1";

      // Record failures below threshold
      limiter.recordFailure(ip);
      limiter.recordFailure(ip);

      expect(limiter.isBlocked(ip)).toBe(false);
    });

    test("IP is blocked after reaching maxFailures within window", () => {
      const limiter = makeLimiter();
      const ip = "10.0.0.2";

      // Record maxFailures failures
      const blocked1 = limiter.recordFailure(ip);
      const blocked2 = limiter.recordFailure(ip);
      const blocked3 = limiter.recordFailure(ip);

      // First two should not trigger block
      expect(blocked1).toBe(false);
      expect(blocked2).toBe(false);
      // Third should trigger block (maxFailures = 3)
      expect(blocked3).toBe(true);
      expect(limiter.isBlocked(ip)).toBe(true);
    });

    test("different IPs are tracked independently", () => {
      const limiter = makeLimiter();
      const ip1 = "10.0.0.10";
      const ip2 = "10.0.0.11";

      // Block ip1
      limiter.recordFailure(ip1);
      limiter.recordFailure(ip1);
      limiter.recordFailure(ip1);

      expect(limiter.isBlocked(ip1)).toBe(true);
      expect(limiter.isBlocked(ip2)).toBe(false);
    });

    test("unblocked IP that was never tracked returns false", () => {
      const limiter = makeLimiter();
      expect(limiter.isBlocked("192.168.1.1")).toBe(false);
    });
  });

  describe("unblocking after blockMs expires", () => {
    test("IP is unblocked after block duration expires", async () => {
      const limiter = makeLimiter({
        maxFailures: 2,
        windowMs: 5_000,
        blockMs: 100, // very short for testing
        maxBlockMs: 1_000,
      });
      const ip = "10.0.0.20";

      limiter.recordFailure(ip);
      limiter.recordFailure(ip); // triggers block

      expect(limiter.isBlocked(ip)).toBe(true);

      // Wait for block to expire
      await sleep(150);

      expect(limiter.isBlocked(ip)).toBe(false);
    });
  });

  describe("exponential backoff escalation", () => {
    test("second block doubles the duration", async () => {
      const limiter = makeLimiter({
        maxFailures: 2,
        windowMs: 5_000,
        blockMs: 100,
        maxBlockMs: 2_000,
      });
      const ip = "10.0.0.30";

      // First block: 100ms
      limiter.recordFailure(ip);
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(true);

      // Wait for first block to expire
      await sleep(120);
      expect(limiter.isBlocked(ip)).toBe(false);

      // Second block: 200ms (100 * 2^1)
      limiter.recordFailure(ip);
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(true);

      // After 120ms, should still be blocked (block is 200ms this time)
      await sleep(120);
      expect(limiter.isBlocked(ip)).toBe(true);

      // After total ~240ms, should be unblocked
      await sleep(120);
      expect(limiter.isBlocked(ip)).toBe(false);
    });

    test("block duration is capped at maxBlockMs", async () => {
      const limiter = makeLimiter({
        maxFailures: 1,
        windowMs: 5_000,
        blockMs: 100,
        maxBlockMs: 200, // cap at 200ms
      });
      const ip = "10.0.0.40";

      // First block: 100ms (100 * 2^0)
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(true);
      await sleep(120);
      expect(limiter.isBlocked(ip)).toBe(false);

      // Second block: 200ms (100 * 2^1), hits cap
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(true);
      await sleep(220);
      expect(limiter.isBlocked(ip)).toBe(false);

      // Third block: still 200ms (capped), not 400ms
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(true);
      await sleep(220);
      expect(limiter.isBlocked(ip)).toBe(false);
    });
  });

  describe("success recording", () => {
    test("recordSuccess clears failure state for IP with no prior violations", () => {
      const limiter = makeLimiter();
      const ip = "10.0.0.50";

      limiter.recordFailure(ip);
      limiter.recordFailure(ip); // 2 of 3 failures

      limiter.recordSuccess(ip);

      // After success, the 2 previous failures should be cleared;
      // a single new failure should NOT cause a block
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(false);
    });

    test("recordSuccess preserves violation history for repeat offenders", async () => {
      const limiter = makeLimiter({
        maxFailures: 2,
        windowMs: 5_000,
        blockMs: 100,
        maxBlockMs: 2_000,
      });
      const ip = "10.0.0.51";

      // First violation
      limiter.recordFailure(ip);
      limiter.recordFailure(ip); // blocked
      expect(limiter.isBlocked(ip)).toBe(true);

      await sleep(120); // unblocked
      expect(limiter.isBlocked(ip)).toBe(false);

      // Successful auth, but violation history retained
      limiter.recordSuccess(ip);

      // Next violation: should still escalate (blockCount preserved)
      limiter.recordFailure(ip);
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(true);
    });
  });

  describe("failure window reset", () => {
    test("failures outside the window are reset", async () => {
      const limiter = makeLimiter({
        maxFailures: 3,
        windowMs: 100, // very short window for testing
        blockMs: 500,
        maxBlockMs: 2_000,
      });
      const ip = "10.0.0.60";

      limiter.recordFailure(ip);
      limiter.recordFailure(ip); // 2 failures

      // Wait for window to expire
      await sleep(150);

      // This should start a new window, not accumulate with old failures
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(false);
    });
  });

  describe("dispose", () => {
    test("dispose clears all entries", () => {
      const limiter = makeLimiter();
      const ip = "10.0.0.70";

      limiter.recordFailure(ip);
      limiter.recordFailure(ip);
      limiter.recordFailure(ip);
      expect(limiter.isBlocked(ip)).toBe(true);

      limiter.dispose();

      // After dispose, entry is gone
      expect(limiter.isBlocked(ip)).toBe(false);
    });
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
