/**
 * Manages multiple Claude accounts with priority-based selection and failover.
 *
 * Selection strategy:
 * 1. Filter to enabled accounts not in cooldown
 * 2. Filter to accounts with remaining hourly quota (if maxTokensPerHour set)
 * 3. Sort by: priority (highest first) > fewest consecutive failures > most remaining quota
 * 4. Return first match
 */

import type { ClaudeAccount, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

interface AccountState {
  readonly account: ClaudeAccount;
  tokensUsedThisHour: number;
  lastErrorAt: number | null;
  consecutiveFailures: number;
  cooldownUntil: number | null;
}

export class AccountRotation {
  private readonly states: AccountState[];
  private readonly logger: Logger;
  private hourBucketStart: number;

  constructor(accounts: readonly ClaudeAccount[], logger: Logger) {
    this.logger = logger.child("accounts");
    this.hourBucketStart = this.getCurrentHourStart();
    this.states = accounts.map((account) => ({
      account,
      tokensUsedThisHour: 0,
      lastErrorAt: null,
      consecutiveFailures: 0,
      cooldownUntil: null,
    }));
  }

  /** Select the best available account. */
  selectAccount(): Result<ClaudeAccount, EidolonError> {
    this.resetHourlyQuotaIfNeeded();

    const available = this.states.filter((s) => {
      if (!s.account.enabled) return false;
      if (s.cooldownUntil && Date.now() < s.cooldownUntil) return false;
      if (s.account.maxTokensPerHour && s.tokensUsedThisHour >= s.account.maxTokensPerHour) return false;
      return true;
    });

    if (available.length === 0) {
      return Err(createError(ErrorCode.CLAUDE_RATE_LIMITED, "All accounts exhausted or in cooldown"));
    }

    available.sort((a, b) => {
      const priorityDiff = b.account.priority - a.account.priority;
      if (priorityDiff !== 0) return priorityDiff;

      const failureDiff = a.consecutiveFailures - b.consecutiveFailures;
      if (failureDiff !== 0) return failureDiff;

      const aRemaining = (a.account.maxTokensPerHour ?? Number.POSITIVE_INFINITY) - a.tokensUsedThisHour;
      const bRemaining = (b.account.maxTokensPerHour ?? Number.POSITIVE_INFINITY) - b.tokensUsedThisHour;
      return bRemaining - aRemaining;
    });

    const selected = available[0];
    if (!selected) {
      return Err(createError(ErrorCode.CLAUDE_RATE_LIMITED, "No accounts available"));
    }

    this.logger.debug("select", `Selected account: ${selected.account.name}`, {
      priority: selected.account.priority,
      tokensUsed: selected.tokensUsedThisHour,
    });

    return Ok(selected.account);
  }

  /** Report successful usage of tokens. */
  reportUsage(accountName: string, tokensUsed: number): void {
    const state = this.findState(accountName);
    if (state) {
      state.tokensUsedThisHour += tokensUsed;
      state.consecutiveFailures = 0;
      state.lastErrorAt = null;
      state.cooldownUntil = null;
    }
  }

  /** Report a failure (rate limit, auth error, etc.). */
  reportFailure(accountName: string, isRateLimit: boolean): void {
    const state = this.findState(accountName);
    if (!state) return;

    state.consecutiveFailures++;
    state.lastErrorAt = Date.now();

    if (isRateLimit) {
      const cooldownMs = Math.min(30_000 * 2 ** (state.consecutiveFailures - 1), 600_000);
      state.cooldownUntil = Date.now() + cooldownMs;
      this.logger.warn("cooldown", `Account ${accountName} rate limited, cooldown ${cooldownMs / 1000}s`, {
        consecutiveFailures: state.consecutiveFailures,
      });
    }
  }

  /** Get status of all accounts. */
  getStatus(): ReadonlyArray<{
    name: string;
    enabled: boolean;
    priority: number;
    tokensUsedThisHour: number;
    consecutiveFailures: number;
    available: boolean;
  }> {
    this.resetHourlyQuotaIfNeeded();
    return this.states.map((s) => ({
      name: s.account.name,
      enabled: s.account.enabled,
      priority: s.account.priority,
      tokensUsedThisHour: s.tokensUsedThisHour,
      consecutiveFailures: s.consecutiveFailures,
      available:
        s.account.enabled &&
        (!s.cooldownUntil || Date.now() >= s.cooldownUntil) &&
        (!s.account.maxTokensPerHour || s.tokensUsedThisHour < s.account.maxTokensPerHour),
    }));
  }

  /**
   * Expose hourBucketStart for testing purposes.
   * @internal
   */
  _setHourBucketStart(timestamp: number): void {
    this.hourBucketStart = timestamp;
  }

  private findState(accountName: string): AccountState | undefined {
    return this.states.find((s) => s.account.name === accountName);
  }

  private getCurrentHourStart(): number {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours()).getTime();
  }

  private resetHourlyQuotaIfNeeded(): void {
    const currentHour = this.getCurrentHourStart();
    if (currentHour > this.hourBucketStart) {
      this.hourBucketStart = currentHour;
      for (const state of this.states) {
        state.tokensUsedThisHour = 0;
      }
    }
  }
}
