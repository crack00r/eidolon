/**
 * Structured JSON logger implementation.
 *
 * Outputs log entries to stdout (process.stdout.write) in JSON or pretty format.
 * Level filtering is applied based on the configured minimum level.
 */

import type { LogEntry, LoggingConfig, LogLevel } from "@eidolon/protocol";
import { formatLogEntry } from "./formatter.ts";

export interface Logger {
  debug(module: string, message: string, data?: Record<string, unknown>): void;
  info(module: string, message: string, data?: Record<string, unknown>): void;
  warn(module: string, message: string, data?: Record<string, unknown>): void;
  error(module: string, message: string, error?: unknown, data?: Record<string, unknown>): void;
  child(module: string): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Patterns matching sensitive data keys that should be auto-redacted in log `data`.
 * Matched case-insensitively against data object keys.
 */
const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /passw(?:or)?d/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /auth(?:orization)?/i,
  /credential/i,
  /master[_-]?key/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
  /session[_-]?id/i,
];

/** Placeholder used to replace redacted values. */
const REDACTED = "[REDACTED]";

/**
 * Deep-clone `data` and replace values whose keys match {@link SENSITIVE_KEY_PATTERNS}.
 */
function redactSensitiveKeys(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY_PATTERNS.some((p) => p.test(key))) {
      result[key] = REDACTED;
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactSensitiveKeys(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Normalize an unknown error value into the LogEntry error shape.
 */
function normalizeError(err: unknown): LogEntry["error"] {
  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack,
      code: "code" in err && typeof err.code === "string" ? err.code : undefined,
    };
  }
  if (typeof err === "string") {
    return { message: err };
  }
  return { message: String(err) };
}

/**
 * Check whether a log level meets the minimum configured threshold.
 */
function shouldLog(entryLevel: LogLevel, configLevel: LogLevel): boolean {
  return LEVEL_ORDER[entryLevel] >= LEVEL_ORDER[configLevel];
}

/**
 * Build a LogEntry from the provided fields.
 * Sensitive keys in `data` are automatically redacted.
 */
function buildEntry(
  level: LogLevel,
  module: string,
  message: string,
  data?: Record<string, unknown>,
  error?: unknown,
): LogEntry {
  const safeData = data && Object.keys(data).length > 0 ? redactSensitiveKeys(data) : undefined;
  const entry: LogEntry = {
    level,
    timestamp: Date.now(),
    module,
    message,
    ...(safeData ? { data: safeData } : {}),
    ...(error !== undefined ? { error: normalizeError(error) } : {}),
  };
  return entry;
}

/**
 * Write a formatted log entry to stdout.
 */
function writeEntry(entry: LogEntry, format: "json" | "pretty"): void {
  const line = formatLogEntry(entry, format);
  process.stdout.write(`${line}\n`);
}

/**
 * Create a Logger instance with the given configuration.
 */
export function createLogger(config: LoggingConfig): Logger {
  return createLoggerWithPrefix(config, "");
}

/**
 * Internal factory that supports module prefixing for child loggers.
 */
function createLoggerWithPrefix(config: LoggingConfig, prefix: string): Logger {
  const resolveModule = (module: string): string => (prefix ? `${prefix}:${module}` : module);

  const logger: Logger = {
    debug(module: string, message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("debug", config.level)) return;
      writeEntry(buildEntry("debug", resolveModule(module), message, data), config.format);
    },

    info(module: string, message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("info", config.level)) return;
      writeEntry(buildEntry("info", resolveModule(module), message, data), config.format);
    },

    warn(module: string, message: string, data?: Record<string, unknown>): void {
      if (!shouldLog("warn", config.level)) return;
      writeEntry(buildEntry("warn", resolveModule(module), message, data), config.format);
    },

    error(module: string, message: string, error?: unknown, data?: Record<string, unknown>): void {
      if (!shouldLog("error", config.level)) return;
      writeEntry(buildEntry("error", resolveModule(module), message, data, error), config.format);
    },

    child(module: string): Logger {
      return createLoggerWithPrefix(config, resolveModule(module));
    },
  };

  return logger;
}
