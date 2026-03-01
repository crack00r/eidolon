/**
 * IP-based authentication rate limiter with exponential backoff.
 *
 * Tracks failed auth attempts per IP address and blocks IPs after
 * exceeding the configured failure threshold.
 */

import type { Logger } from "../logging/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  readonly maxFailures: number;
  readonly windowMs: number;
  readonly blockMs: number;
  readonly maxBlockMs: number;
}

interface RateLimitEntry {
  failures: number;
  firstFailureAt: number;
  blockedUntil: number;
  blockCount: number;
}

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  maxFailures: 5,
  windowMs: 60_000,
  blockMs: 300_000,
  maxBlockMs: 3_600_000,
};

// ---------------------------------------------------------------------------
// AuthRateLimiter
// ---------------------------------------------------------------------------

const CLEANUP_INTERVAL_MS = 60_000;

export class AuthRateLimiter {
  private readonly config: RateLimitConfig;
  private readonly logger: Logger;
  private readonly entries: Map<string, RateLimitEntry> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(config: RateLimitConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, CLEANUP_INTERVAL_MS);
  }

  /** Check whether an IP is currently blocked. */
  isBlocked(ip: string): boolean {
    const entry = this.entries.get(ip);
    if (!entry) return false;

    if (entry.blockedUntil > 0 && Date.now() < entry.blockedUntil) {
      return true;
    }

    // Block expired — check if we should clear the entry
    if (entry.blockedUntil > 0 && Date.now() >= entry.blockedUntil) {
      // Unblock but keep history so next failure escalates
      entry.blockedUntil = 0;
      entry.failures = 0;
      entry.firstFailureAt = 0;
    }

    return false;
  }

  /**
   * Record a failed auth attempt. Returns true if the IP is now blocked.
   */
  recordFailure(ip: string): boolean {
    const now = Date.now();
    let entry = this.entries.get(ip);

    if (!entry) {
      entry = { failures: 0, firstFailureAt: now, blockedUntil: 0, blockCount: 0 };
      this.entries.set(ip, entry);
    }

    // Reset failure window if expired
    if (now - entry.firstFailureAt > this.config.windowMs) {
      entry.failures = 0;
      entry.firstFailureAt = now;
    }

    entry.failures++;

    if (entry.failures >= this.config.maxFailures) {
      // Exponential backoff: blockMs * 2^blockCount, capped at maxBlockMs
      const backoffMs = Math.min(this.config.blockMs * 2 ** entry.blockCount, this.config.maxBlockMs);
      entry.blockedUntil = now + backoffMs;
      entry.blockCount++;
      entry.failures = 0;
      entry.firstFailureAt = 0;

      this.logger.warn("rate-limit", `Blocked IP ${ip} for ${backoffMs}ms (block #${entry.blockCount})`);

      return true;
    }

    return false;
  }

  /** Record a successful auth — clears all history for the IP. */
  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }

  /** Cleanup interval and release resources. */
  dispose(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.entries.clear();
  }

  /** Remove expired entries (no longer blocked and outside failure window). */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [ip, entry] of this.entries) {
      const blockExpired = entry.blockedUntil === 0 || now >= entry.blockedUntil;
      const windowExpired = now - entry.firstFailureAt > this.config.windowMs;
      if (blockExpired && windowExpired && entry.failures === 0) {
        this.entries.delete(ip);
      }
    }
  }
}
