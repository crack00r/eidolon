/**
 * Parser for Claude Code CLI streaming JSON output.
 *
 * Claude Code with `--output-format stream-json` emits one JSON object per line.
 * This module converts each line into a typed StreamEvent.
 */

import type { StreamEvent } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

/**
 * Type guard: checks that a value is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extract a Claude CLI session ID from a parsed JSON object.
 * Checks common field names used by the Claude CLI output.
 */
function pickSessionId(parsed: Record<string, unknown>): string | undefined {
  const fields = ["session_id", "sessionId", "conversation_id"];
  for (const field of fields) {
    const value = parsed[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

/**
 * Parse a single line of Claude Code streaming JSON output into a StreamEvent.
 * Returns null for lines that don't represent meaningful events (empty lines, etc.)
 *
 * When the parsed JSON contains a `session_id` field (typically in `result` events),
 * an additional `session` event is returned via the `extraEvents` out-parameter
 * so callers can capture the CLI session ID for future `--resume` calls.
 */
export function parseStreamLine(line: string, logger?: Logger, extraEvents?: StreamEvent[]): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const snippet = trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
    if (logger) {
      logger.warn("parser", `Failed to parse stream line as JSON: ${snippet}`);
    } else {
      console.warn(`[parser] Failed to parse stream line as JSON: ${snippet}`);
    }
    return null;
  }

  if (!isRecord(parsed)) return null;

  const now = Date.now();

  // Check for session_id in any event type and emit a session event if found
  const cliSessionId = pickSessionId(parsed);
  if (cliSessionId && extraEvents) {
    extraEvents.push({ type: "session", sessionId: cliSessionId, timestamp: now });
  }

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
export function parseStreamOutput(output: string, logger?: Logger): StreamEvent[] {
  return output
    .split("\n")
    .map((line) => parseStreamLine(line, logger))
    .filter((event): event is StreamEvent => event !== null);
}
