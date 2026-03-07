/**
 * Telegram retry and error classification helpers.
 *
 * Extracted from channel.ts to keep file sizes manageable.
 * Provides retry logic for transient API failures and fatal error detection.
 */

import { GrammyError, HttpError } from "grammy";
import type { Logger } from "../../logging/logger.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_RETRIES = 3;
export const INITIAL_RETRY_DELAY_MS = 500;

/** Fatal error descriptions that indicate the bot token is invalid or revoked. */
const FATAL_ERROR_PATTERNS: readonly RegExp[] = [
  /unauthorized/i,
  /bot.*was.*blocked/i,
  /bot.*was.*kicked/i,
  /not found/i,
];

// ---------------------------------------------------------------------------
// Fatal error detection
// ---------------------------------------------------------------------------

/** Check whether an error indicates a fatal, non-recoverable bot issue. */
export function isFatalBotError(err: unknown): boolean {
  if (err instanceof GrammyError) {
    // 401 Unauthorized = token revoked
    if (err.error_code === 401) return true;
    // Check description against known fatal patterns
    const desc = err.description ?? "";
    return FATAL_ERROR_PATTERNS.some((p) => p.test(desc));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Retry logic
// ---------------------------------------------------------------------------

/**
 * Execute an API call with retry logic for transient failures.
 * Handles HTTP 429 (rate limit) by respecting Telegram's `retry_after` parameter.
 */
export async function sendWithRetry<T>(fn: () => Promise<T>, logger: Logger): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry fatal errors
      if (isFatalBotError(err)) {
        throw err;
      }

      // Last attempt — give up
      if (attempt === MAX_RETRIES) break;

      // Handle HTTP 429 with retry_after from Telegram
      let delayMs = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
      if (err instanceof GrammyError && err.error_code === 429) {
        const parameters = (err as GrammyError & { parameters?: { retry_after?: number } }).parameters;
        const retryAfter = parameters?.retry_after;
        if (typeof retryAfter === "number" && retryAfter > 0) {
          delayMs = retryAfter * 1000;
        }
      }

      // Only retry on transient HTTP errors (429, 5xx) or network errors
      const isRetryable =
        err instanceof HttpError || (err instanceof GrammyError && (err.error_code === 429 || err.error_code >= 500));

      if (!isRetryable) {
        throw err;
      }

      logger.warn("telegram", `API call failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delayMs}ms`, {
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

/** Promise-based sleep for retry delays. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
