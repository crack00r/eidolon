/**
 * Token usage tracking and cost calculation.
 *
 * Records token usage per session into the operational database,
 * calculates costs based on model pricing, and provides summaries.
 */

import type { Database } from "bun:sqlite";
import type { CostSummary, EidolonError, Result, SessionType, TokenUsage } from "@eidolon/protocol";
import { createError, DEFAULT_MODEL_PRICING, Err, ErrorCode, MODEL_PRICING, Ok } from "@eidolon/protocol";
import { z } from "zod";

const SessionTypeSchema = z.enum(["main", "task", "learning", "dream", "voice", "review"]);
import type { Logger } from "../logging/logger.ts";

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
  const pricing = looked ?? DEFAULT_MODEL_PRICING;
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
          const parsed = SessionTypeSchema.safeParse(row.session_type);
          if (parsed.success) {
            bySessionType[parsed.data] = row.cost;
          }
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
        session_type: string;
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
        sessionType: SessionTypeSchema.parse(row.session_type),
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
