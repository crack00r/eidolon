/**
 * Claude provider -- wraps ClaudeCodeManager as an ILLMProvider.
 *
 * This is the primary provider for conversation, code generation, and complex
 * reasoning tasks.  It delegates to the existing ClaudeCodeManager which
 * handles account rotation, workspace preparation, and streaming.
 */

import type {
  ILLMProvider,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMMessage,
  LLMStreamEvent,
} from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

/**
 * Minimal subset of ClaudeCodeManager needed by this provider.
 * Avoids a hard dependency on the full manager.
 */
export interface ClaudeManagerLike {
  isAvailable(): Promise<boolean>;
}

export class ClaudeProvider implements ILLMProvider {
  readonly type = "claude" as const;
  readonly name = "Claude (via Claude Code CLI)";

  constructor(
    private readonly manager: ClaudeManagerLike,
    private readonly logger: Logger,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.manager.isAvailable();
  }

  async listModels(): Promise<readonly string[]> {
    // Claude model selection is handled by account rotation config
    return ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250514"];
  }

  async complete(messages: readonly LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    // Claude completion is handled through ClaudeCodeManager sessions.
    // This provider is mainly used for routing decisions -- the actual
    // invocation goes through the existing session pipeline.
    this.logger.debug("llm:claude", "complete() called -- delegate to session pipeline", {
      messageCount: messages.length,
      model: options?.model,
    });

    return {
      content: "",
      usage: { inputTokens: 0, outputTokens: 0 },
      model: options?.model ?? "claude-sonnet-4-20250514",
      finishReason: "stop",
    };
  }

  async *stream(messages: readonly LLMMessage[], _options?: LLMCompletionOptions): AsyncIterable<LLMStreamEvent> {
    this.logger.debug("llm:claude", "stream() called -- delegate to session pipeline", {
      messageCount: messages.length,
    });
    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
