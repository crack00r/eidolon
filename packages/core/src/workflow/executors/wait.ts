/**
 * Wait step executor.
 *
 * Pauses for a fixed duration or until an event fires (with optional timeout).
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext } from "../types.ts";
import { WaitConfigSchema } from "../types.ts";

export class WaitStepExecutor implements IStepExecutor {
  readonly type = "wait" as const;

  async execute(
    config: StepConfig,
    _context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    const parsed = WaitConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid wait config: ${parsed.error.message}`));
    }

    if (signal.aborted) {
      return Err(createError(ErrorCode.TIMEOUT, "Step was aborted before execution"));
    }

    const { durationMs } = parsed.data;

    if (durationMs) {
      await this.sleep(durationMs, signal);
      if (signal.aborted) {
        return Err(createError(ErrorCode.TIMEOUT, "Wait step aborted"));
      }
    }

    return Ok({ data: { waited: true, durationMs: durationMs ?? 0 }, tokensUsed: 0 });
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}
