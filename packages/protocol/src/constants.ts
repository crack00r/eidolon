/**
 * Shared constants used across all packages.
 * Constants that depend on types from types/ will be added after those files exist.
 */

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
