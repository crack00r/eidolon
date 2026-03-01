/**
 * Token usage tracking and cost calculation.
 *
 * Records token usage per session into the operational database,
 * calculates costs based on model pricing, and provides summaries.
 */

import type { Database } from "bun:sqlite";
import type { CostSummary, EidolonError, Result, SessionType, TokenUsage } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

/** Model pricing in cents per 1M tokens. */
const MODEL_PRICING: Record<
  string,
  { inputPer1M: number; outputPer1M: number; cacheReadPer1M: number; cacheWritePer1M: number }
> = {
  "claude-opus-4-20250514": { inputPer1M: 1500, outputPer1M: 7500, cacheReadPer1M: 150, cacheWritePer1M: 1875 },
  "claude-sonnet-4-20250514": { inputPer1M: 300, outputPer1M: 1500, cacheReadPer1M: 30, cacheWritePer1M: 375 },
  "claude-haiku-3-20250414": { inputPer1M: 80, outputPer1M: 400, cacheReadPer1M: 8, cacheWritePer1M: 100 },
};

/** Default pricing (Sonnet) for unknown models. */
const DEFAULT_PRICING = {
  inputPer1M: 300,
  outputPer1M: 1500,
  cacheReadPer1M: 30,
  cacheWritePer1M: 375,
} as const;

/** Period durations in milliseconds. */
const PERIOD_MS: Record<"hour" | "day" | "week" | "month", number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
};

/** Calculate cost in USD for given token counts. */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheRead = 0,
  cacheWrite = 0,
): number {
  const looked = MODEL_PRICING[model];
  const pricing = looked ?? DEFAULT_PRICING;
  const costCents =
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M +
    (cacheRead / 1_000_000) * pricing.cacheReadPer1M +
    (cacheWrite / 1_000_000) * pricing.cacheWritePer1M;
  return costCents / 100;
}

export class TokenTracker {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("token-tracker");
  }

  /** Record token usage for a session. */
  record(usage: TokenUsage): Result<void, EidolonError> {
    try {
      this.db
        .query(
          `INSERT INTO token_usage (session_id, session_type, model, input_tokens, output_tokens,
           cache_read_tokens, cache_write_tokens, cost_usd, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          usage.sessionId,
          usage.sessionType,
          usage.model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cacheReadTokens,
          usage.cacheWriteTokens,
          usage.costUsd,
          usage.timestamp,
        );

      this.logger.debug("record", "Token usage recorded", {
        sessionId: usage.sessionId,
        model: usage.model,
        cost: usage.costUsd,
      });

      return Ok(undefined);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to record token usage: ${message}`, err));
    }
  }

  /** Get cost summary for a time period. */
  getSummary(period: "hour" | "day" | "week" | "month"): Result<CostSummary, EidolonError> {
    try {
      const since = Date.now() - PERIOD_MS[period];

      const totalsRaw = this.db
        .query(
          `SELECT COALESCE(SUM(cost_usd), 0) as totalCost,
                  COALESCE(SUM(input_tokens), 0) as totalInput,
                  COALESCE(SUM(output_tokens), 0) as totalOutput
           FROM token_usage WHERE timestamp >= ?`,
        )
        .get(since) as Record<string, unknown> | null;

      const totals = {
        totalCost: typeof totalsRaw?.totalCost === "number" ? totalsRaw.totalCost : 0,
        totalInput: typeof totalsRaw?.totalInput === "number" ? totalsRaw.totalInput : 0,
        totalOutput: typeof totalsRaw?.totalOutput === "number" ? totalsRaw.totalOutput : 0,
      };

      const byTypeRaw = this.db
        .query(
          `SELECT session_type, SUM(cost_usd) as cost
           FROM token_usage WHERE timestamp >= ? GROUP BY session_type`,
        )
        .all(since) as Array<Record<string, unknown>>;

      const byModelRaw = this.db
        .query(
          `SELECT model, SUM(cost_usd) as cost
           FROM token_usage WHERE timestamp >= ? GROUP BY model`,
        )
        .all(since) as Array<Record<string, unknown>>;

      const bySessionType: Partial<Record<SessionType, number>> = {};
      for (const row of byTypeRaw) {
        if (typeof row.session_type === "string" && typeof row.cost === "number") {
          bySessionType[row.session_type as SessionType] = row.cost;
        }
      }

      const byModelMap: Record<string, number> = {};
      for (const row of byModelRaw) {
        if (typeof row.model === "string" && typeof row.cost === "number") {
          byModelMap[row.model] = row.cost;
        }
      }

      return Ok({
        period,
        totalCostUsd: totals.totalCost,
        totalInputTokens: totals.totalInput,
        totalOutputTokens: totals.totalOutput,
        bySessionType,
        byModel: byModelMap,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get cost summary: ${message}`, err));
    }
  }

  /** Get all usage records for a session. */
  getSessionUsage(sessionId: string): Result<TokenUsage[], EidolonError> {
    try {
      const rows = this.db
        .query(
          `SELECT session_id, session_type, model, input_tokens, output_tokens,
                  cache_read_tokens, cache_write_tokens, cost_usd, timestamp
           FROM token_usage WHERE session_id = ? ORDER BY timestamp ASC`,
        )
        .all(sessionId) as Array<{
        session_id: string;
        session_type: SessionType;
        model: string;
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_write_tokens: number;
        cost_usd: number;
        timestamp: number;
      }>;

      const usages: TokenUsage[] = rows.map((row) => ({
        sessionId: row.session_id,
        sessionType: row.session_type,
        model: row.model,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens,
        costUsd: row.cost_usd,
        timestamp: row.timestamp,
      }));

      return Ok(usages);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get session usage: ${message}`, err));
    }
  }
}
