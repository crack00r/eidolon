/**
 * Shared constants used across all packages.
 * Constants that depend on types from types/ will be added after those files exist.
 */

import type { SessionType } from "./types/sessions.js";

export const VERSION = "0.0.0";

export const DEFAULT_CONFIG_FILENAME = "eidolon.json";
export const DEFAULT_DATA_DIR_NAME = "eidolon";
export const MEMORY_DB_FILENAME = "memory.db";
export const OPERATIONAL_DB_FILENAME = "operational.db";
export const AUDIT_DB_FILENAME = "audit.db";
export const SECRETS_DB_FILENAME = "secrets.db";

export const MAX_EMBEDDING_DIMENSIONS = 384;
export const RRF_K = 60;

export const CIRCUIT_BREAKER_DEFAULTS = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
  halfOpenMaxAttempts: 3,
} as const;

export const RETRY_DEFAULTS = {
  maxRetries: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 60_000,
  backoffMultiplier: 2,
} as const;

// ---------------------------------------------------------------------------
// Tool Whitelisting per Session Type
// ---------------------------------------------------------------------------
// Each session type receives only the Claude Code tools it needs.
// Tool names match the Claude Code CLI --allowedTools flag values.
// See docs/design/CLAUDE_INTEGRATION.md for design rationale.

export const SESSION_TOOL_WHITELIST: Record<SessionType, readonly string[]> = {
  main: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch"],
  task: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  learning: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch"],
  dream: ["Read", "Glob", "Grep"],
  voice: ["Read", "Glob", "Grep"],
  review: ["Read", "Glob", "Grep", "WebFetch"],
} as const;

// ---------------------------------------------------------------------------
// Model Pricing (cents per 1M tokens)
// ---------------------------------------------------------------------------
// Canonical pricing data. Import this from @eidolon/protocol instead of
// duplicating in consumer code.

export interface ModelPricingEntry {
  readonly inputPer1M: number;
  readonly outputPer1M: number;
  readonly cacheReadPer1M: number;
  readonly cacheWritePer1M: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricingEntry>> = {
  "claude-opus-4-20250514": { inputPer1M: 1500, outputPer1M: 7500, cacheReadPer1M: 150, cacheWritePer1M: 1875 },
  "claude-sonnet-4-20250514": { inputPer1M: 300, outputPer1M: 1500, cacheReadPer1M: 30, cacheWritePer1M: 375 },
  "claude-haiku-3-20250414": { inputPer1M: 80, outputPer1M: 400, cacheReadPer1M: 8, cacheWritePer1M: 100 },
} as const;

export const DEFAULT_MODEL_PRICING: ModelPricingEntry = {
  inputPer1M: 300,
  outputPer1M: 1500,
  cacheReadPer1M: 30,
  cacheWritePer1M: 375,
} as const;
