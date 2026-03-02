/**
 * Log entry formatting -- JSON or pretty-printed output.
 */

import type { LogEntry } from "@eidolon/protocol";

/**
 * Regex matching dangerous control characters (NUL, BS, VT, FF, etc.)
 * but preserving TAB (\x09), LF (\x0A), and CR (\x0D).
 * Constructed via RegExp to satisfy the noControlCharactersInRegex lint rule.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control-char sanitization
const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Sanitize control characters from log messages to prevent log injection.
 */
function sanitizeLogMessage(msg: string): string {
  return msg.replace(CONTROL_CHAR_RE, "");
}

/**
 * Format a LogEntry as a string in the specified format.
 *
 * Both JSON and pretty formats apply control-character sanitization to
 * message, error.message, and error.stack to prevent log injection.
 */
export function formatLogEntry(entry: LogEntry, format: "json" | "pretty"): string {
  if (format === "json") {
    // Sanitize user-controlled fields before JSON serialization to prevent log injection
    const sanitized: LogEntry = {
      ...entry,
      message: sanitizeLogMessage(entry.message),
      ...(entry.error
        ? {
            error: {
              ...entry.error,
              message: sanitizeLogMessage(entry.error.message),
              ...(entry.error.stack ? { stack: sanitizeLogMessage(entry.error.stack) } : {}),
            },
          }
        : {}),
    };
    return JSON.stringify(sanitized);
  }
  return formatPretty(entry);
}

/**
 * Pretty format:
 * [2026-03-01 14:30:00.123] INFO  core:config          -- Config loaded {"path":"/etc/eidolon/eidolon.json"}
 */
function formatPretty(entry: LogEntry): string {
  const time = new Date(entry.timestamp).toISOString().replace("T", " ").replace("Z", "");
  const level = entry.level.toUpperCase().padEnd(5);
  const module = entry.module.padEnd(20);
  const message = sanitizeLogMessage(entry.message);
  const parts: string[] = [`[${time}] ${level} ${module} -- ${message}`];

  if (entry.data && Object.keys(entry.data).length > 0) {
    parts[0] += ` ${JSON.stringify(entry.data)}`;
  }

  if (entry.error) {
    // SEC-H11: Sanitize error.message and error.stack in pretty format to
    // prevent log injection via control characters in error strings.
    parts.push(`  Error: ${sanitizeLogMessage(entry.error.message)}`);
    if (entry.error.stack) {
      parts.push(`  ${sanitizeLogMessage(entry.error.stack)}`);
    }
  }

  return parts.join("\n");
}
