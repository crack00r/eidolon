/**
 * Parser for Claude Code CLI streaming JSON output.
 *
 * Claude Code with `--output-format stream-json` emits one JSON object per line.
 * This module converts each line into a typed StreamEvent.
 */

import type { StreamEvent } from "@eidolon/protocol";

/**
 * Type guard: checks that a value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Parse a single line of Claude Code streaming JSON output into a StreamEvent.
 * Returns null for lines that don't represent meaningful events (empty lines, etc.)
 */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Intentional: non-JSON lines are skipped
    return null;
  }

  if (!isRecord(parsed)) return null;

  const now = Date.now();

  if (parsed.type === "assistant") {
    const message = parsed.message;
    if (!isRecord(message)) return null;

    if (message.type === "text") {
      return { type: "text", content: String(message.text ?? ""), timestamp: now };
    }

    if (message.type === "tool_use") {
      return {
        type: "tool_use",
        toolName: String(message.name ?? ""),
        toolInput: isRecord(message.input) ? message.input : {},
        timestamp: now,
      };
    }

    return null;
  }

  if (parsed.type === "result") {
    if (typeof parsed.tool_use_id === "string") {
      return { type: "tool_result", toolResult: parsed.result, timestamp: now };
    }
    return { type: "text", content: String(parsed.result ?? ""), timestamp: now };
  }

  if (parsed.type === "system") {
    return { type: "system", content: String(parsed.message ?? ""), timestamp: now };
  }

  if (parsed.type === "error") {
    return {
      type: "error",
      error: String(parsed.error ?? parsed.message ?? "Unknown error"),
      timestamp: now,
    };
  }

  // Unknown type -- surface as a system message
  return { type: "system", content: JSON.stringify(parsed), timestamp: now };
}

/**
 * Parse multiple lines of streaming output into an array of StreamEvents.
 */
export function parseStreamOutput(output: string): StreamEvent[] {
  return output
    .split("\n")
    .map(parseStreamLine)
    .filter((event): event is StreamEvent => event !== null);
}
