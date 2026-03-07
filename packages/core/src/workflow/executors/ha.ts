/**
 * Home automation step executor.
 *
 * Delegates to HAManager for entity control.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { HAManager } from "../../home-automation/manager.ts";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext } from "../types.ts";
import { HaCommandConfigSchema } from "../types.ts";

export interface HaExecutorDeps {
  readonly haManager: HAManager;
}

export class HaStepExecutor implements IStepExecutor {
  readonly type = "ha_command" as const;

  constructor(private readonly deps: HaExecutorDeps) {}

  async execute(
    config: StepConfig,
    _context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    const parsed = HaCommandConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid ha_command config: ${parsed.error.message}`));
    }

    if (signal.aborted) {
      return Err(createError(ErrorCode.TIMEOUT, "Step was aborted before execution"));
    }

    const { entityId, action, params } = parsed.data;

    try {
      const domain = entityId.split(".")[0] ?? "unknown";
      const result = await this.deps.haManager.executeService(
        entityId,
        domain,
        action,
        (params ?? {}) as Record<string, unknown>,
      );

      if (!result.ok) {
        return Err(result.error);
      }

      return Ok({ data: { entityId, action, success: true }, tokensUsed: 0 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.HA_SERVICE_FAILED, `HA command failed: ${msg}`, err));
    }
  }
}
