/**
 * Log entry formatting -- JSON or pretty-printed output.
 */

import type { LogEntry } from "@eidolon/protocol";

/**
 * Format a LogEntry as a string in the specified format.
 */
export function formatLogEntry(entry: LogEntry, format: "json" | "pretty"): string {
  if (format === "json") {
    return JSON.stringify(entry);
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
  const parts: string[] = [`[${time}] ${level} ${module} -- ${entry.message}`];

  if (entry.data && Object.keys(entry.data).length > 0) {
    parts[0] += ` ${JSON.stringify(entry.data)}`;
  }

  if (entry.error) {
    parts.push(`  Error: ${entry.error.message}`);
    if (entry.error.stack) {
      parts.push(`  ${entry.error.stack}`);
    }
  }

  return parts.join("\n");
}
