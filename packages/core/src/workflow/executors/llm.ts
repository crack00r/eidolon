/**
 * LLM call step executor.
 *
 * Uses IClaudeProcess to execute LLM prompts within a workflow step.
 * Tracks token usage from the response.
 */

import type { ClaudeSessionOptions, EidolonError, IClaudeProcess, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext } from "../types.ts";
import { LlmCallConfigSchema } from "../types.ts";

export interface LlmExecutorDeps {
  readonly createProcess: () => IClaudeProcess;
  readonly workspaceDir: string;
}

export class LlmStepExecutor implements IStepExecutor {
  readonly type = "llm_call" as const;

  constructor(private readonly deps: LlmExecutorDeps) {}

  async execute(
    config: StepConfig,
    _context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    const parsed = LlmCallConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid llm_call config: ${parsed.error.message}`));
    }

    if (signal.aborted) {
      return Err(createError(ErrorCode.TIMEOUT, "Step was aborted before execution"));
    }

    const { prompt, systemPrompt, model } = parsed.data;

    try {
      const process = this.deps.createProcess();
      const options: ClaudeSessionOptions = {
        workspaceDir: this.deps.workspaceDir,
        model,
        systemPrompt,
      };

      let responseText = "";
      let tokensUsed = 0;

      for await (const event of process.run(prompt, options)) {
        if (signal.aborted) {
          return Err(createError(ErrorCode.TIMEOUT, "Step aborted during execution"));
        }
        if (event.type === "text" && event.content) {
          responseText += event.content;
        }
        if (event.type === "error") {
          return Err(createError(ErrorCode.CLAUDE_PROCESS_CRASHED, `LLM error: ${event.error ?? "unknown"}`));
        }
      }

      // Estimate tokens from text length since IClaudeProcess doesn't emit usage events
      tokensUsed = Math.ceil((prompt.length + responseText.length) / 4);

      return Ok({ data: responseText, tokensUsed });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.CLAUDE_PROCESS_CRASHED, `LLM call failed: ${msg}`, err));
    }
  }
}
