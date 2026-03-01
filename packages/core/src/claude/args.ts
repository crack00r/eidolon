/**
 * Builds the CLI argument array for spawning Claude Code.
 *
 * Extracted as a standalone function so it can be unit-tested
 * without spawning a real subprocess.
 */

import type { ClaudeSessionOptions } from "@eidolon/protocol";

/**
 * Build the full CLI argument list for a Claude Code invocation.
 * The returned array does NOT include the leading `claude` binary name.
 */
export function buildClaudeArgs(prompt: string, options: ClaudeSessionOptions): readonly string[] {
  const args: string[] = ["--print", "--output-format", "stream-json"];

  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }

  if (options.mcpConfig) {
    args.push("--mcp-config", options.mcpConfig);
  }

  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }

  // Prompt is always the last positional argument
  args.push(prompt);

  return args;
}
