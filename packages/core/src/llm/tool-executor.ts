/**
 * Tool executor -- executes LLM tool calls for providers that don't natively
 * support tool calling (like basic Ollama models).
 *
 * This implements a simple ReAct-style loop: the provider generates a tool
 * call in a structured format, this executor runs it, and feeds the result
 * back for the next iteration.
 */

import type { IToolExecutor, LLMToolCall, LLMToolDefinition, LLMToolResult } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

/** Built-in tool implementations that can be used by any provider. */
type ToolImplementation = (args: Record<string, unknown>) => Promise<string>;

export class ToolExecutor implements IToolExecutor {
  private readonly tools = new Map<string, ToolImplementation>();

  constructor(private readonly logger: Logger) {}

  registerTool(name: string, impl: ToolImplementation): void {
    this.tools.set(name, impl);
  }

  async execute(
    call: LLMToolCall,
    _definitions: readonly LLMToolDefinition[],
  ): Promise<LLMToolResult> {
    const impl = this.tools.get(call.name);
    if (!impl) {
      return {
        toolCallId: call.id,
        content: `Tool "${call.name}" not found`,
        isError: true,
      };
    }

    try {
      const result = await impl(call.arguments);
      return { toolCallId: call.id, content: result };
    } catch (err) {
      this.logger.error("llm:tool-executor", `Tool ${call.name} failed`, err);
      return {
        toolCallId: call.id,
        content: `Tool execution error: ${String(err)}`,
        isError: true,
      };
    }
  }
}
