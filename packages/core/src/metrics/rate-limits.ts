/**
 * Rate limit tracking for Claude accounts.
 *
 * Uses the `account_usage` table in operational.db to track per-account
 * token usage, errors, and cooldown state. Provides a unified view of
 * each account's availability for the dashboard and Prometheus metrics.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountRateLimitStatus {
  readonly accountName: string;
  readonly tokensUsedCurrentHour: number;
  readonly maxTokensPerHour: number;
  readonly remainingTokens: number;
  readonly cooldownUntil: number | null;
  readonly consecutiveErrors: number;
  readonly lastErrorAt: number | null;
  readonly isAvailable: boolean;
}

export interface HourlyUsageEntry {
  readonly hour: number;
  readonly tokens: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the hour bucket (timestamp floored to the start of the hour) for a given timestamp. */
function getHourBucket(timestamp: number): number {
  return Math.floor(timestamp / 3_600_000) * 3_600_000;
}

// ---------------------------------------------------------------------------
// RateLimitTracker
// ---------------------------------------------------------------------------

export class RateLimitTracker {
  private readonly db: Database;
  private readonly logger: Logger;

  /**
   * In-memory cooldown state per account.
   * Maps account name to cooldown-until timestamp (ms).
   */
  private readonly cooldowns: Map<string, number> = new Map();

  /**
   * In-memory consecutive error count per account.
   * Reset on successful usage recording.
   */
  private readonly consecutiveErrors: Map<string, number> = new Map();

  /**
   * In-memory last error timestamp per account.
   */
  private readonly lastErrors: Map<string, number> = new Map();

  /**
   * Per-account max tokens per hour.
   * Set via recordUsage context or configured externally.
   * Defaults to 0 (unlimited) if not configured.
   */
  private readonly maxTokensPerHour: Map<string, number> = new Map();

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("rate-limits");
  }

  /** Configure the max tokens per hour for an account. */
  setMaxTokensPerHour(accountName: string, max: number): void {
    this.maxTokensPerHour.set(accountName, max);
  }

  /** Record token usage for an account. Resets consecutive error count. */
  recordUsage(accountName: string, tokensUsed: number): void {
    const now = Date.now();
    const hourBucket = getHourBucket(now);

    try {
      this.db
        .query(
          `INSERT INTO account_usage (account_name, hour_bucket, tokens_used, requests, errors, last_error)
           VALUES (?, ?, ?, 1, 0, NULL)
           ON CONFLICT(account_name, hour_bucket) DO UPDATE SET
             tokens_used = tokens_used + ?,
             requests = requests + 1`,
        )
        .run(accountName, hourBucket, tokensUsed, tokensUsed);

      // Clear consecutive errors on success
      this.consecutiveErrors.delete(accountName);

      this.logger.debug("record-usage", `Recorded ${tokensUsed} tokens for ${accountName}`, {
        accountName,
        tokensUsed,
        hourBucket,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("record-usage", `Failed to record usage for ${accountName}: ${message}`, err);
    }
  }

  /** Record an error for an account. Increments consecutive error count. */
  recordError(accountName: string, error: string): void {
    const now = Date.now();
    const hourBucket = getHourBucket(now);

    const prevErrors = this.consecutiveErrors.get(accountName) ?? 0;
    this.consecutiveErrors.set(accountName, prevErrors + 1);
    this.lastErrors.set(accountName, now);

    try {
      this.db
        .query(
          `INSERT INTO account_usage (account_name, hour_bucket, tokens_used, requests, errors, last_error)
           VALUES (?, ?, 0, 0, 1, ?)
           ON CONFLICT(account_name, hour_bucket) DO UPDATE SET
             errors = errors + 1,
             last_error = ?`,
        )
        .run(accountName, hourBucket, error, error);

      this.logger.debug("record-error", `Recorded error for ${accountName}`, {
        accountName,
        error,
        consecutiveErrors: prevErrors + 1,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error("record-error", `Failed to record error for ${accountName}: ${message}`, err);
    }
  }

  /** Set a cooldown period for an account. */
  recordCooldown(accountName: string, cooldownUntilMs: number): void {
    this.cooldowns.set(accountName, cooldownUntilMs);
    this.logger.info(
      "record-cooldown",
      `Account ${accountName} in cooldown until ${new Date(cooldownUntilMs).toISOString()}`,
      {
        accountName,
        cooldownUntilMs,
      },
    );
  }

  /** Clear the cooldown for an account. */
  clearCooldown(accountName: string): void {
    this.cooldowns.delete(accountName);
    this.logger.debug("clear-cooldown", `Cooldown cleared for ${accountName}`, { accountName });
  }

  /** Get rate limit status for a single account. */
  getAccountStatus(accountName: string): AccountRateLimitStatus {
    const now = Date.now();
    const hourBucket = getHourBucket(now);

    let tokensUsedCurrentHour = 0;
    try {
      const row = this.db
        .query(
          `SELECT tokens_used FROM account_usage
           WHERE account_name = ? AND hour_bucket = ?`,
        )
        .get(accountName, hourBucket) as { tokens_used: number } | null;

      tokensUsedCurrentHour = row?.tokens_used ?? 0;
    } catch (err: unknown) {
      this.logger.warn("getAccountStatus", `DB query failed for account ${accountName}, defaulting to 0`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const max = this.maxTokensPerHour.get(accountName) ?? 0;
    const remaining = max > 0 ? Math.max(0, max - tokensUsedCurrentHour) : 0;
    const cooldownUntil = this.cooldowns.get(accountName) ?? null;
    const consecutiveErrors = this.consecutiveErrors.get(accountName) ?? 0;
    const lastErrorAt = this.lastErrors.get(accountName) ?? null;

    const isInCooldown = cooldownUntil !== null && cooldownUntil > now;
    const isOverBudget = max > 0 && tokensUsedCurrentHour >= max;
    const isAvailable = !isInCooldown && !isOverBudget;

    return {
      accountName,
      tokensUsedCurrentHour,
      maxTokensPerHour: max,
      remainingTokens: max > 0 ? remaining : -1,
      cooldownUntil: isInCooldown ? cooldownUntil : null,
      consecutiveErrors,
      lastErrorAt,
      isAvailable,
    };
  }

  /** Get rate limit statuses for all known accounts. */
  getAllAccountStatuses(): readonly AccountRateLimitStatus[] {
    const now = Date.now();
    const hourBucket = getHourBucket(now);

    // Collect all known account names from DB and in-memory state
    const accountNames = new Set<string>();

    try {
      const rows = this.db
        .query(`SELECT DISTINCT account_name FROM account_usage WHERE hour_bucket >= ?`)
        .all(hourBucket - 3_600_000 * 24) as Array<{ account_name: string }>;

      for (const row of rows) {
        accountNames.add(row.account_name);
      }
    } catch (err: unknown) {
      this.logger.warn("getAllAccountStatuses", "DB query failed, continuing with in-memory state only", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Also include accounts from in-memory state
    for (const name of this.cooldowns.keys()) {
      accountNames.add(name);
    }
    for (const name of this.consecutiveErrors.keys()) {
      accountNames.add(name);
    }
    for (const name of this.maxTokensPerHour.keys()) {
      accountNames.add(name);
    }

    return [...accountNames].map((name) => this.getAccountStatus(name));
  }

  /** Get hourly usage history for an account over the last N hours. */
  getHourlyUsage(accountName: string, hours = 24): readonly HourlyUsageEntry[] {
    const now = Date.now();
    const sinceHour = getHourBucket(now) - (hours - 1) * 3_600_000;

    try {
      const rows = this.db
        .query(
          `SELECT hour_bucket, tokens_used FROM account_usage
           WHERE account_name = ? AND hour_bucket >= ?
           ORDER BY hour_bucket ASC`,
        )
        .all(accountName, sinceHour) as Array<{ hour_bucket: number; tokens_used: number }>;

      return rows.map((row) => ({
        hour: row.hour_bucket,
        tokens: row.tokens_used,
      }));
    } catch (err: unknown) {
      this.logger.warn("getHourlyUsage", `DB query failed for account ${accountName}, returning empty history`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }
}
