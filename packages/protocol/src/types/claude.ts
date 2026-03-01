/**
 * IClaudeProcess interface and related types for Claude Code CLI integration.
 */

import type { EidolonError } from "../errors.js";
import type { Result } from "../result.js";

export interface StreamEvent {
  readonly type: "text" | "tool_use" | "tool_result" | "error" | "done" | "system";
  readonly content?: string;
  readonly toolName?: string;
  readonly toolInput?: Record<string, unknown>;
  readonly toolResult?: unknown;
  readonly error?: string;
  readonly timestamp: number;
}

export interface ClaudeSessionOptions {
  readonly sessionId?: string;
  readonly workspaceDir: string;
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly mcpConfig?: string;
  readonly maxTurns?: number;
  readonly systemPrompt?: string;
  readonly timeoutMs?: number;
  readonly env?: Record<string, string>;
}

export interface IClaudeProcess {
  run(prompt: string, options: ClaudeSessionOptions): AsyncIterable<StreamEvent>;
  isAvailable(): Promise<boolean>;
  getVersion(): Promise<Result<string, EidolonError>>;
  abort(sessionId: string): Promise<void>;
}
