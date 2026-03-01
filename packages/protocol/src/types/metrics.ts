/**
 * Token usage and cost tracking types.
 */

import type { SessionType } from "./sessions.js";

export interface TokenUsage {
  readonly sessionId: string;
  readonly sessionType: SessionType;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
  readonly timestamp: number;
}

export interface CostSummary {
  readonly period: "hour" | "day" | "week" | "month";
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly bySessionType: Partial<Record<SessionType, number>>;
  readonly byModel: Record<string, number>;
}

export interface ModelPricing {
  readonly model: string;
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly cacheReadPer1M: number;
  readonly cacheWritePer1M: number;
}
