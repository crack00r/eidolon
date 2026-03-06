/**
 * LLM provider abstraction types.
 *
 * ILLMProvider sits above IClaudeProcess and enables routing tasks to local
 * models (Ollama, llama.cpp) or Claude depending on the task type.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type LLMRole = "system" | "user" | "assistant" | "tool";

export interface LLMMessage {
  readonly role: LLMRole;
  readonly content: string;
  readonly name?: string;
  readonly toolCallId?: string;
}

// ---------------------------------------------------------------------------
// Tool call types
// ---------------------------------------------------------------------------

export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export interface LLMToolResult {
  readonly toolCallId: string;
  readonly content: string;
  readonly isError?: boolean;
}

export interface LLMToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Completion options
// ---------------------------------------------------------------------------

export interface LLMCompletionOptions {
  readonly model?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly stopSequences?: readonly string[];
  readonly tools?: readonly LLMToolDefinition[];
  readonly systemPrompt?: string;
}

// ---------------------------------------------------------------------------
// Completion result
// ---------------------------------------------------------------------------

export interface LLMCompletionResult {
  readonly content: string;
  readonly toolCalls?: readonly LLMToolCall[];
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly model: string;
  readonly finishReason: "stop" | "tool_use" | "max_tokens" | "error";
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type LLMStreamEventType = "text" | "tool_call" | "done" | "error";

export interface LLMStreamEvent {
  readonly type: LLMStreamEventType;
  readonly text?: string;
  readonly toolCall?: LLMToolCall;
  readonly usage?: { inputTokens: number; outputTokens: number };
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export type LLMProviderType = "claude" | "ollama" | "llamacpp";

export interface ILLMProvider {
  readonly type: LLMProviderType;
  readonly name: string;

  /** Check whether the provider backend is reachable. */
  isAvailable(): Promise<boolean>;

  /** List available models. */
  listModels(): Promise<readonly string[]>;

  /** Non-streaming completion. */
  complete(messages: readonly LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult>;

  /** Streaming completion. */
  stream(messages: readonly LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamEvent>;

  /** Generate embeddings (optional -- not all providers support it). */
  embed?(texts: readonly string[]): Promise<readonly Float32Array[]>;
}

// ---------------------------------------------------------------------------
// Task-based routing
// ---------------------------------------------------------------------------

export type TaskRequirementType =
  | "conversation"
  | "extraction"
  | "filtering"
  | "dreaming"
  | "code-generation"
  | "summarization"
  | "embedding";

export interface TaskRequirement {
  readonly type: TaskRequirementType;
  /** Minimum context window size in tokens. */
  readonly minContextLength?: number;
  /** Whether tool use is required. */
  readonly requiresTools?: boolean;
}

export interface IModelRouter {
  /**
   * Select the best provider for a given task requirement.
   * Returns provider names in priority order.
   */
  route(task: TaskRequirement): readonly LLMProviderType[];

  /**
   * Select the first available provider for a task.
   * Returns undefined if no provider is available.
   */
  selectProvider(task: TaskRequirement): Promise<ILLMProvider | undefined>;
}

// ---------------------------------------------------------------------------
// Tool executor (for providers that don't natively support tool calling)
// ---------------------------------------------------------------------------

export interface IToolExecutor {
  /** Execute a tool call and return the result. */
  execute(call: LLMToolCall, definitions: readonly LLMToolDefinition[]): Promise<LLMToolResult>;
}
