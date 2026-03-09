/**
 * Shared constants used across all packages.
 * Constants that depend on types from types/ will be added after those files exist.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SessionType } from "./types/sessions.ts";

function loadVersion(): string {
  // Build-time injected version (works in compiled binaries via --define)
  if (
    typeof process.env.EIDOLON_BUILD_VERSION === "string" &&
    process.env.EIDOLON_BUILD_VERSION !== "" &&
    process.env.EIDOLON_BUILD_VERSION !== "undefined"
  ) {
    return process.env.EIDOLON_BUILD_VERSION;
  }

  // Runtime file-based fallback (works in normal bun run / bun build --outfile)
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(thisDir, "..", "package.json");
    const pkg: unknown = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (
      typeof pkg === "object" &&
      pkg !== null &&
      "version" in pkg &&
      typeof (pkg as Record<string, unknown>).version === "string"
    ) {
      return (pkg as Record<string, unknown>).version as string;
    }
    return "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const VERSION: string = loadVersion();

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
  main: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch"],
  task: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
  learning: ["Read", "Glob", "Grep"], // restricted: no write, no shell
  dream: ["Read", "Glob", "Grep"],
  voice: ["Read", "Glob", "Grep", "Bash", "WebFetch"],
  review: ["Read", "Glob", "Grep"],
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
