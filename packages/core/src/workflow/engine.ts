/**
 * WorkflowEngine -- orchestrates workflow execution, state transitions,
 * DAG traversal, and crash recovery.
 *
 * Integrates with the EventBus: each step executes as one PEAR cycle event.
 * The engine does NOT run its own loop -- it reacts to workflow events.
 */

import { randomUUID } from "node:crypto";
import type { BusEvent, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { EventHandlerResult } from "../loop/cognitive-loop.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { Logger } from "../logging/logger.ts";
import { interpolateConfig } from "./interpolation.ts";
import type { StepExecutorRegistry } from "./executor-registry.ts";
import type { WorkflowStore } from "./store.ts";
import type {
  IWorkflowEngine,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunStatus,
  WorkflowStepDef,
  WorkflowStepReadyPayload,
  WorkflowTriggerPayload,
} from "./types.ts";
import {
  DEFAULT_STEP_TIMEOUT_MS,
  MAX_CONCURRENT_WORKFLOWS,
} from "./types.ts";
import { evaluateCondition } from "./executors/condition.ts";
import {
  advanceWorkflow as advanceWorkflowImpl,
  handleStepFailure as handleStepFailureImpl,
  markStepSkipped as markStepSkippedImpl,
  publishReadySteps as publishReadyStepsImpl,
  validateDag,
} from "./engine-dag.ts";

// ---------------------------------------------------------------------------
// WorkflowEngine
// ---------------------------------------------------------------------------

export class WorkflowEngine implements IWorkflowEngine {
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(
    private readonly store: WorkflowStore,
    private readonly registry: StepExecutorRegistry,
    private readonly eventBus: EventBus,
    private readonly logger: Logger,
  ) {}

  // -- Public API -----------------------------------------------------------

  createDefinition(def: WorkflowDefinition): Result<WorkflowDefinition, EidolonError> {
    const dagResult = validateDag(def.steps);
    if (!dagResult.ok) return dagResult;
    return this.store.createDefinition(def);
  }

  startRun(definitionId: string, triggerPayload?: unknown): Result<WorkflowRun, EidolonError> {
    // Check concurrency limit
    const countResult = this.store.countActiveRuns();
    if (!countResult.ok) return Err(countResult.error);
    if (countResult.value >= MAX_CONCURRENT_WORKFLOWS) {
      return Err(createError(ErrorCode.SESSION_LIMIT_REACHED, `Maximum ${MAX_CONCURRENT_WORKFLOWS} concurrent workflows reached`));
    }

    // Verify definition exists
    const defResult = this.store.getDefinition(definitionId);
    if (!defResult.ok) return Err(defResult.error);

    const runId = randomUUID();
    const runResult = this.store.createRun(runId, definitionId, triggerPayload);
    if (!runResult.ok) return Err(runResult.error);

    // Transition to running
    const updateResult = this.store.updateRunStatus(runId, "running");
    if (!updateResult.ok) return Err(updateResult.error);

    // Create pending step results for all steps
    const def = defResult.value;
    for (const step of def.steps) {
      const stepResultId = randomUUID();
      const createResult = this.store.createStepResult({
        id: stepResultId,
        runId,
        stepId: step.id,
        status: "pending",
        output: null,
        error: null,
        attempt: 1,
        startedAt: null,
        completedAt: null,
        tokensUsed: 0,
      });
      if (!createResult.ok) {
        this.logger.error("workflow-engine", `Failed to create step result: ${createResult.error.message}`);
      }
    }

    // Find and publish ready steps (those with no dependencies)
    publishReadyStepsImpl(runId, def, this.store, this.eventBus);

    this.logger.info("workflow-engine", `Started workflow run: ${runId} (definition: ${definitionId})`);
    return this.store.getRun(runId);
  }

  async processEvent(event: BusEvent): Promise<EventHandlerResult> {
    switch (event.type) {
      case "workflow:trigger":
        return this.handleTrigger(event);
      case "workflow:step_ready":
        return this.handleStepReady(event);
      default:
        return { success: true, tokensUsed: 0 };
    }
  }

  cancelRun(runId: string): Result<void, EidolonError> {
    const runResult = this.store.getRun(runId);
    if (!runResult.ok) return Err(runResult.error);

    const run = runResult.value;
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return Err(createError(ErrorCode.INVALID_TRANSITION, `Cannot cancel run in ${run.status} state`));
    }

    // Abort any running step
    const controller = this.abortControllers.get(runId);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(runId);
    }

    const updateResult = this.store.updateRunStatus(runId, "cancelled");
    if (!updateResult.ok) return Err(updateResult.error);

    this.eventBus.publish("workflow:cancelled", { runId, definitionId: run.definitionId }, {
      priority: "normal",
      source: "workflow-engine",
    });

    this.logger.info("workflow-engine", `Cancelled workflow run: ${runId}`);
    return Ok(undefined);
  }

  recoverRunningWorkflows(): Result<number, EidolonError> {
    let recovered = 0;

    for (const status of ["running", "waiting", "retrying"] as const) {
      const runsResult = this.store.getRunsByStatus(status);
      if (!runsResult.ok) return Err(runsResult.error);

      for (const run of runsResult.value) {
        const defResult = this.store.getDefinition(run.definitionId);
        if (!defResult.ok) {
          this.logger.warn("workflow-engine", `Skipping recovery for run ${run.id}: definition not found`);
          continue;
        }

        const stepsResult = this.store.getStepResults(run.id);
        if (!stepsResult.ok) continue;

        // Check for timed-out running steps
        for (const step of stepsResult.value) {
          if (step.status === "running" && step.startedAt) {
            const stepDef = defResult.value.steps.find((s) => s.id === step.stepId);
            const timeoutMs = stepDef?.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
            if (Date.now() - step.startedAt > timeoutMs) {
              this.store.updateStepResult(step.id, { status: "failed", error: "Timed out during crash recovery" });
            }
          }
        }

        // Re-publish ready steps
        publishReadyStepsImpl(run.id, defResult.value, this.store, this.eventBus);
        recovered++;
      }
    }

    this.logger.info("workflow-engine", `Recovered ${recovered} workflow run(s)`);
    return Ok(recovered);
  }

  getRunStatus(runId: string): Result<WorkflowRunStatus, EidolonError> {
    const runResult = this.store.getRun(runId);
    if (!runResult.ok) return Err(runResult.error);

    const stepsResult = this.store.getStepResults(runId);
    if (!stepsResult.ok) return Err(stepsResult.error);

    const defResult = this.store.getDefinition(runResult.value.definitionId);
    if (!defResult.ok) return Err(defResult.error);

    return Ok({
      run: runResult.value,
      steps: stepsResult.value,
      definition: defResult.value,
    });
  }

  /** Cancel all active runs (for shutdown). */
  cancelAllActive(): void {
    for (const status of ["running", "waiting", "retrying"] as const) {
      const runsResult = this.store.getRunsByStatus(status);
      if (!runsResult.ok) continue;
      for (const run of runsResult.value) {
        this.cancelRun(run.id);
      }
    }
  }

  // -- Private: Event Handlers ----------------------------------------------

  private handleTrigger(event: BusEvent): EventHandlerResult {
    const payload = event.payload as WorkflowTriggerPayload;
    const result = this.startRun(payload.definitionId, payload.triggerPayload);
    if (!result.ok) {
      this.logger.error("workflow-engine", `Failed to start run: ${result.error.message}`);
      return { success: false, tokensUsed: 0, error: result.error.message };
    }
    return { success: true, tokensUsed: 0 };
  }

  private async handleStepReady(event: BusEvent): Promise<EventHandlerResult> {
    const payload = event.payload as WorkflowStepReadyPayload;
    const { runId, stepId } = payload;

    const runResult = this.store.getRun(runId);
    if (!runResult.ok) {
      return { success: false, tokensUsed: 0, error: runResult.error.message };
    }
    const run = runResult.value;

    if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
      return { success: true, tokensUsed: 0 };
    }

    const defResult = this.store.getDefinition(run.definitionId);
    if (!defResult.ok) {
      return { success: false, tokensUsed: 0, error: defResult.error.message };
    }

    const stepDef = defResult.value.steps.find((s) => s.id === stepId);
    if (!stepDef) {
      return { success: false, tokensUsed: 0, error: `Step not found: ${stepId}` };
    }

    // Check condition (skip if false)
    if (stepDef.condition) {
      const condResult = evaluateCondition(stepDef.condition, run.context);
      if (!condResult) {
        markStepSkippedImpl(runId, stepId, this.store);
        advanceWorkflowImpl(runId, defResult.value, this.store, this.eventBus, this.logger);
        return { success: true, tokensUsed: 0 };
      }
    }

    // Execute the step
    const execResult = await this.executeStep(runId, stepDef, run.context);

    if (execResult.ok) {
      // Update context with step output
      const newOutputs = new Map(run.context.stepOutputs);
      newOutputs.set(stepId, execResult.value.data);
      const newContext: WorkflowContext = {
        ...run.context,
        stepOutputs: newOutputs,
      };
      this.store.updateRunStatus(runId, "running", { context: newContext, currentStepId: null });

      this.eventBus.publish("workflow:step_completed", {
        runId,
        stepId,
        tokensUsed: execResult.value.tokensUsed,
      }, { priority: "normal", source: "workflow-engine" });

      advanceWorkflowImpl(runId, defResult.value, this.store, this.eventBus, this.logger);
      return { success: true, tokensUsed: execResult.value.tokensUsed };
    }

    // Step failed
    const retryPolicy = stepDef.retryPolicy;
    const stepResultRes = this.store.getStepResult(runId, stepId);
    const currentAttempt = stepResultRes.ok && stepResultRes.value ? stepResultRes.value.attempt : 1;

    if (retryPolicy && currentAttempt < retryPolicy.maxAttempts) {
      // Retry
      const backoff = Math.min(
        retryPolicy.backoffMs * retryPolicy.backoffMultiplier ** (currentAttempt - 1),
        retryPolicy.maxBackoffMs,
      );
      this.store.updateRunStatus(runId, "retrying");

      setTimeout(() => {
        const newResultId = randomUUID();
        this.store.createStepResult({
          id: newResultId,
          runId,
          stepId,
          status: "pending",
          output: null,
          error: null,
          attempt: currentAttempt + 1,
          startedAt: null,
          completedAt: null,
          tokensUsed: 0,
        });
        this.eventBus.publish("workflow:step_ready", { runId, stepId }, {
          priority: "normal",
          source: "workflow-engine",
        });
      }, backoff);

      return { success: true, tokensUsed: 0 };
    }

    // Step permanently failed
    handleStepFailureImpl(runId, defResult.value, stepId, execResult.error.message, this.store, this.eventBus);
    return { success: false, tokensUsed: 0, error: execResult.error.message };
  }

  // -- Private: Step Execution ----------------------------------------------

  private async executeStep(
    runId: string,
    stepDef: WorkflowStepDef,
    context: WorkflowContext,
  ): Promise<Result<{ data: unknown; tokensUsed: number }, EidolonError>> {
    const executorResult = this.registry.get(stepDef.type);
    if (!executorResult.ok) return Err(executorResult.error);

    const executor = executorResult.value;
    const interpolatedConfig = interpolateConfig(stepDef.config, context);

    const controller = new AbortController();
    this.abortControllers.set(runId, controller);

    // Update step result to running
    const existingResult = this.store.getStepResult(runId, stepDef.id);
    if (existingResult.ok && existingResult.value) {
      this.store.updateStepResult(existingResult.value.id, { status: "running" });
    }

    this.store.updateRunStatus(runId, "running", { currentStepId: stepDef.id });

    const timeoutMs = stepDef.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const result = await executor.execute(interpolatedConfig, context, controller.signal);
      clearTimeout(timeoutId);
      this.abortControllers.delete(runId);

      if (result.ok) {
        if (existingResult.ok && existingResult.value) {
          this.store.updateStepResult(existingResult.value.id, {
            status: "completed",
            output: result.value.data,
            tokensUsed: result.value.tokensUsed,
          });
        }
        return Ok({ data: result.value.data, tokensUsed: result.value.tokensUsed });
      }

      if (existingResult.ok && existingResult.value) {
        this.store.updateStepResult(existingResult.value.id, {
          status: "failed",
          error: result.error.message,
        });
      }
      return Err(result.error);
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      this.abortControllers.delete(runId);
      const msg = err instanceof Error ? err.message : String(err);
      if (existingResult.ok && existingResult.value) {
        this.store.updateStepResult(existingResult.value.id, {
          status: "failed",
          error: msg,
        });
      }
      return Err(createError(ErrorCode.TIMEOUT, `Step execution error: ${msg}`, err));
    }
  }

}
