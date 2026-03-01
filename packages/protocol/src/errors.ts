/**
 * Error codes and the EidolonError type.
 * Every expected failure in the system maps to one of these codes.
 */

export const ErrorCode = {
  // Config
  CONFIG_NOT_FOUND: "CONFIG_NOT_FOUND",
  CONFIG_INVALID: "CONFIG_INVALID",
  CONFIG_PARSE_ERROR: "CONFIG_PARSE_ERROR",
  // Secrets
  SECRET_NOT_FOUND: "SECRET_NOT_FOUND",
  SECRET_DECRYPTION_FAILED: "SECRET_DECRYPTION_FAILED",
  MASTER_KEY_MISSING: "MASTER_KEY_MISSING",
  // Database
  DB_CONNECTION_FAILED: "DB_CONNECTION_FAILED",
  DB_MIGRATION_FAILED: "DB_MIGRATION_FAILED",
  DB_QUERY_FAILED: "DB_QUERY_FAILED",
  // Claude
  CLAUDE_NOT_INSTALLED: "CLAUDE_NOT_INSTALLED",
  CLAUDE_AUTH_FAILED: "CLAUDE_AUTH_FAILED",
  CLAUDE_RATE_LIMITED: "CLAUDE_RATE_LIMITED",
  CLAUDE_PROCESS_CRASHED: "CLAUDE_PROCESS_CRASHED",
  CLAUDE_TIMEOUT: "CLAUDE_TIMEOUT",
  // Sessions
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_LIMIT_REACHED: "SESSION_LIMIT_REACHED",
  // Memory
  MEMORY_EXTRACTION_FAILED: "MEMORY_EXTRACTION_FAILED",
  EMBEDDING_FAILED: "EMBEDDING_FAILED",
  // Channel
  CHANNEL_AUTH_FAILED: "CHANNEL_AUTH_FAILED",
  CHANNEL_SEND_FAILED: "CHANNEL_SEND_FAILED",
  // Gateway
  GATEWAY_AUTH_FAILED: "GATEWAY_AUTH_FAILED",
  // GPU
  GPU_UNAVAILABLE: "GPU_UNAVAILABLE",
  GPU_AUTH_FAILED: "GPU_AUTH_FAILED",
  TTS_FAILED: "TTS_FAILED",
  STT_FAILED: "STT_FAILED",
  // Learning
  DISCOVERY_FAILED: "DISCOVERY_FAILED",
  // General
  TIMEOUT: "TIMEOUT",
  CIRCUIT_OPEN: "CIRCUIT_OPEN",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface EidolonError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly cause?: unknown;
  readonly timestamp: number;
}

export function createError(code: ErrorCode, message: string, cause?: unknown): EidolonError {
  return {
    code,
    message,
    cause,
    timestamp: Date.now(),
  };
}
