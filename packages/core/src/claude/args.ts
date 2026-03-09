/**
 * Builds the CLI argument array for spawning Claude Code.
 *
 * Extracted as a standalone function so it can be unit-tested
 * without spawning a real subprocess.
 */

import type { ClaudeSessionOptions } from "@eidolon/protocol";
import { generateSchemaInstruction } from "./structured-output.ts";

/**
 * Build the full CLI argument list for a Claude Code invocation.
 * The returned array does NOT include the leading `claude` binary name.
 *
 * When `options.resumeSessionId` is provided, uses `--resume` for fast session
 * resumption instead of a cold start. Resume mode omits flags that the server
 * already has from the original session (model, allowedTools, systemPrompt).
 *
 * When `options.outputSchema` is provided, a schema instruction is automatically
 * appended to the system prompt so Claude produces valid JSON output.
 */
export function buildClaudeArgs(prompt: string, options: ClaudeSessionOptions): readonly string[] {
  // Resume mode: minimal args since the server already has session config
  if (options.resumeSessionId) {
    return buildResumeArgs(prompt, options);
  }

  const args: string[] = ["--print", "--output-format", "stream-json", "--verbose"];

  // sessionId is used for internal tracking only; not passed to Claude CLI
  // (Claude CLI requires a valid UUID for --session-id, but our IDs have prefixes)
  if (options.model) {
    args.push("--model", options.model);
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }

  if (options.mcpConfig) {
    args.push("--mcp-config", options.mcpConfig);
  }

  if (options.maxTurns != null) {
    args.push("--max-turns", String(options.maxTurns));
  }

  // Build system prompt: combine user-provided prompt with schema instruction if present
  let systemPrompt = options.systemPrompt ?? "";
  if (options.outputSchema) {
    const schemaInstruction = generateSchemaInstruction(options.outputSchema);
    systemPrompt = systemPrompt ? `${systemPrompt}\n\n${schemaInstruction}` : schemaInstruction;
  }

  if (systemPrompt) {
    args.push("--system-prompt", systemPrompt);
  }

  // Use -- separator to prevent prompts starting with -- from being parsed as flags
  args.push("--", prompt);

  return args;
}

/**
 * Build minimal args for resuming an existing Claude CLI session.
 * Omits model, allowedTools, systemPrompt, and mcpConfig since the server
 * already has these from the original session.
 */
function buildResumeArgs(prompt: string, options: ClaudeSessionOptions): readonly string[] {
  const args: string[] = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    options.resumeSessionId!,
  ];

  // max-turns can still be overridden per-resume
  if (options.maxTurns != null) {
    args.push("--max-turns", String(options.maxTurns));
  }

  args.push("--", prompt);

  return args;
}
