/**
 * StepExecutorRegistry -- maps StepType to its executor implementation.
 *
 * Step executors are registered at daemon init time and looked up
 * by the WorkflowEngine when executing steps.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { IStepExecutor, StepType } from "./types.ts";

export class StepExecutorRegistry {
  private readonly executors = new Map<StepType, IStepExecutor>();

  register(executor: IStepExecutor): void {
    this.executors.set(executor.type, executor);
  }

  get(type: StepType): Result<IStepExecutor, EidolonError> {
    const executor = this.executors.get(type);
    if (!executor) {
      return Err(
        createError(ErrorCode.CONFIG_INVALID, `No executor registered for step type: ${type}`),
      );
    }
    return Ok(executor);
  }

  has(type: StepType): boolean {
    return this.executors.has(type);
  }

  getRegisteredTypes(): readonly StepType[] {
    return [...this.executors.keys()];
  }
}
