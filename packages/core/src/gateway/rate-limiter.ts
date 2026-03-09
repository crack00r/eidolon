/**
 * IP-based authentication rate limiter with exponential backoff.
 *
 * Tracks failed auth attempts per IP address and blocks IPs after
 * exceeding the configured failure threshold.
 */

import type { Logger } from "../logging/logger.ts";
import { anonymizeIp } from "./server-helpers.ts";

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
  /** Timestamp of the last violation (block). Decays slowly over time. */
  lastViolationAt: number;
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

/**
 * SEC-M9: Maximum number of tracked IP entries to prevent unbounded memory growth.
 * An attacker could send auth attempts from many spoofed IPs to exhaust memory.
 */
const MAX_ENTRIES = 10_000;

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
    this.cleanupTimer.unref();
  }

  /** Check whether an IP is currently blocked. */
  isBlocked(ip: string): boolean {
    const entry = this.entries.get(ip);
    if (!entry) return false;

    const now = Date.now();

    if (entry.blockedUntil > 0 && now < entry.blockedUntil) {
      return true;
    }

    // Block expired — unblock but keep violation history so next failure escalates.
    // Slowly decay blockCount: reduce by 1 for every full maxBlockMs period since
    // the last violation, so persistent abusers still face long lockouts.
    if (entry.blockedUntil > 0 && now >= entry.blockedUntil) {
      entry.blockedUntil = 0;
      entry.failures = 0;
      entry.firstFailureAt = 0;

      if (entry.lastViolationAt > 0) {
        const elapsed = now - entry.lastViolationAt;
        const decaySteps = Math.floor(elapsed / this.config.maxBlockMs);
        entry.blockCount = Math.max(0, entry.blockCount - decaySteps);
      }
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
      // SEC-M9: Enforce maximum entries to prevent unbounded memory growth
      if (this.entries.size >= MAX_ENTRIES) {
        this.evictOldest();
      }
      entry = { failures: 0, firstFailureAt: now, blockedUntil: 0, blockCount: 0, lastViolationAt: 0 };
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
      entry.lastViolationAt = now;
      entry.failures = 0;
      entry.firstFailureAt = 0;

      // Finding #18: Anonymize IP in log output
      this.logger.warn("rate-limit", `Blocked IP ${anonymizeIp(ip)} for ${backoffMs}ms (block #${entry.blockCount})`);

      return true;
    }

    return false;
  }

  /**
   * Record a successful auth.
   * Clears failure state but preserves violation history (blockCount) with
   * time-based decay so that repeat offenders still face escalating lockouts.
   */
  recordSuccess(ip: string): void {
    const entry = this.entries.get(ip);
    if (!entry) return;

    // If no prior violations, simply remove the entry
    if (entry.blockCount === 0) {
      this.entries.delete(ip);
      return;
    }

    // Decay blockCount based on time since last violation
    const now = Date.now();
    if (entry.lastViolationAt > 0) {
      const elapsed = now - entry.lastViolationAt;
      const decaySteps = Math.floor(elapsed / this.config.maxBlockMs);
      entry.blockCount = Math.max(0, entry.blockCount - decaySteps);
    }

    // If fully decayed, remove the entry
    if (entry.blockCount === 0) {
      this.entries.delete(ip);
      return;
    }

    // Otherwise, reset failure counters but keep violation history
    entry.failures = 0;
    entry.firstFailureAt = 0;
    entry.blockedUntil = 0;
  }

  /** Cleanup interval and release resources. */
  dispose(): void {
    if (this.cleanupTimer !== undefined) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    this.entries.clear();
  }

  /**
   * SEC-M9: Evict the oldest non-blocked entry when MAX_ENTRIES is reached.
   * Prefers removing fully decayed entries first, then the oldest by firstFailureAt.
   */
  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;

    for (const [ip, entry] of this.entries) {
      // Skip currently blocked IPs -- they must not be evicted
      if (entry.blockedUntil > 0 && Date.now() < entry.blockedUntil) continue;
      const entryTime = Math.max(entry.firstFailureAt, entry.lastViolationAt);
      if (entryTime < oldestTime) {
        oldestTime = entryTime;
        oldestKey = ip;
      }
    }

    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }

  /** Remove expired entries (no longer blocked, outside failure window, and fully decayed). */
  private cleanupExpired(): void {
    const now = Date.now();
    for (const [ip, entry] of this.entries) {
      const blockExpired = entry.blockedUntil === 0 || now >= entry.blockedUntil;
      const windowExpired = now - entry.firstFailureAt > this.config.windowMs;

      // Decay blockCount based on time since last violation
      if (entry.lastViolationAt > 0 && entry.blockCount > 0) {
        const elapsed = now - entry.lastViolationAt;
        const decaySteps = Math.floor(elapsed / this.config.maxBlockMs);
        entry.blockCount = Math.max(0, entry.blockCount - decaySteps);
        if (entry.blockCount === 0) entry.lastViolationAt = 0;
      }

      if (blockExpired && windowExpired && entry.failures === 0 && entry.blockCount === 0) {
        this.entries.delete(ip);
      }
    }
  }
}
