/**
 * Client-side logger with ring buffer for phone-home error reporting.
 * Wraps console.* with timestamps, module tags, and retains the
 * last N error entries for diagnostic retrieval.
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface LogEntry {
  level: LogLevel;
  module: string;
  message: string;
  data?: unknown;
  timestamp: number;
}

const MAX_BUFFER_SIZE = 100;
const buffer: LogEntry[] = [];

function formatTimestamp(ts: number): string {
  return new Date(ts).toISOString();
}

/**
 * Log a message with level, module tag, and optional structured data.
 * Errors and warnings are stored in a ring buffer for phone-home retrieval.
 */
export function clientLog(level: LogLevel, module: string, message: string, data?: unknown): void {
  const timestamp = Date.now();
  const prefix = `[${formatTimestamp(timestamp)}] [${level.toUpperCase()}] [${module}]`;

  // Console output
  const args: unknown[] = [`${prefix} ${message}`];
  if (data !== undefined) args.push(data);

  switch (level) {
    case "error":
      console.error(...args);
      break;
    case "warn":
      console.warn(...args);
      break;
    case "info":
      console.info(...args);
      break;
    case "debug":
      console.debug(...args);
      break;
  }

  // Store errors and warnings in ring buffer for phone-home
  if (level === "error" || level === "warn") {
    const entry: LogEntry = { level, module, message, timestamp };
    if (data !== undefined) {
      // Avoid storing non-serializable data; stringify safely
      try {
        entry.data = JSON.parse(JSON.stringify(data));
      } catch {
        entry.data = String(data);
      }
    }

    buffer.push(entry);
    if (buffer.length > MAX_BUFFER_SIZE) {
      buffer.shift();
    }
  }
}

/**
 * Retrieve recent error/warning entries from the ring buffer.
 * Returns a shallow copy so consumers cannot mutate the internal buffer.
 */
export function getRecentErrors(): ReadonlyArray<LogEntry> {
  return [...buffer];
}

/**
 * Clear the error ring buffer (e.g. after successful phone-home upload).
 */
export function clearErrorBuffer(): void {
  buffer.length = 0;
}
