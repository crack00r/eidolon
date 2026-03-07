/**
 * Workflow engine DAG traversal and validation -- extracted from engine.ts.
 *
 * Provides ready-step publishing, workflow advancement, condition branching,
 * step failure handling, and DAG cycle detection.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { EventBus } from "../loop/event-bus.ts";
import type { Logger } from "../logging/logger.ts";
import type { WorkflowStore } from "./store.ts";
import type {
  StepResult,
  WorkflowDefinition,
  WorkflowStepDef,
  WorkflowStepReadyPayload,
} from "./types.ts";
import { MAX_PARALLEL_STEPS } from "./types.ts";

// ---------------------------------------------------------------------------
// Ready-step publishing
// ---------------------------------------------------------------------------

/** Find and publish steps whose dependencies are met. */
export function publishReadySteps(
  runId: string,
  def: WorkflowDefinition,
  store: WorkflowStore,
  eventBus: EventBus,
): void {
  const stepsResult = store.getStepResults(runId);
  if (!stepsResult.ok) return;

  const stepResults = stepsResult.value;
  const completedSteps = new Set(
    stepResults.filter((s) => s.status === "completed" || s.status === "skipped").map((s) => s.stepId),
  );

  // Find steps that need to be checked for condition branching
  const enabledSteps = getEnabledSteps(def, stepResults);

  let published = 0;
  for (const step of def.steps) {
    if (completedSteps.has(step.id)) continue;
    if (!enabledSteps.has(step.id)) continue;

    // Check if already pending/running (avoid duplicate publishes)
    const existingPending = stepResults.find(
      (s) => s.stepId === step.id && (s.status === "pending" || s.status === "running"),
    );
    if (existingPending) continue;

    // All dependencies must be completed or skipped
    const depsReady = step.dependsOn.every((dep) => completedSteps.has(dep));
    if (!depsReady) continue;

    if (published >= MAX_PARALLEL_STEPS) break;

    eventBus.publish("workflow:step_ready", { runId, stepId: step.id } satisfies WorkflowStepReadyPayload, {
      priority: "normal",
      source: "workflow-engine",
    });
    published++;
  }
}

// ---------------------------------------------------------------------------
// Condition branching
// ---------------------------------------------------------------------------

/** Determine which steps are enabled based on completed condition steps. */
export function getEnabledSteps(
  def: WorkflowDefinition,
  stepResults: readonly StepResult[],
): Set<string> {
  // By default all steps are enabled
  const enabled = new Set(def.steps.map((s) => s.id));

  // Check completed condition steps to see which branches are enabled
  for (const result of stepResults) {
    if (result.status !== "completed") continue;
    const stepDef = def.steps.find((s) => s.id === result.stepId);
    if (!stepDef || stepDef.type !== "condition") continue;

    const config = stepDef.config as { thenSteps?: string[]; elseSteps?: string[] };
    const conditionResult = result.output as boolean | null;

    if (conditionResult === true) {
      for (const elseId of config.elseSteps ?? []) {
        enabled.delete(elseId);
      }
    } else if (conditionResult === false) {
      for (const thenId of config.thenSteps ?? []) {
        enabled.delete(thenId);
      }
    }
  }

  return enabled;
}

// ---------------------------------------------------------------------------
// Workflow advancement
// ---------------------------------------------------------------------------

/** Check if all enabled steps are done and advance the workflow. */
export function advanceWorkflow(
  runId: string,
  def: WorkflowDefinition,
  store: WorkflowStore,
  eventBus: EventBus,
  logger: Logger,
): void {
  const stepsResult = store.getStepResults(runId);
  if (!stepsResult.ok) return;

  const stepResults = stepsResult.value;
  const enabledSteps = getEnabledSteps(def, stepResults);

  const allDone = [...enabledSteps].every((stepId) =>
    stepResults.some(
      (r) => r.stepId === stepId && (r.status === "completed" || r.status === "skipped"),
    ),
  );

  if (allDone) {
    store.updateRunStatus(runId, "completed");
    eventBus.publish("workflow:completed", {
      runId,
      definitionId: def.id,
    }, { priority: "normal", source: "workflow-engine" });
    logger.info("workflow-engine", `Workflow completed: ${runId}`);
  } else {
    publishReadySteps(runId, def, store, eventBus);
  }
}

// ---------------------------------------------------------------------------
// Step failure handling
// ---------------------------------------------------------------------------

/** Handle a permanently failed step based on the workflow's failure strategy. */
export function handleStepFailure(
  runId: string,
  def: WorkflowDefinition,
  _stepId: string,
  errorMsg: string,
  store: WorkflowStore,
  eventBus: EventBus,
): void {
  const strategy = def.onFailure;
  switch (strategy.type) {
    case "abort":
      store.updateRunStatus(runId, "failed", { error: errorMsg });
      break;
    case "notify":
      store.updateRunStatus(runId, "failed", { error: errorMsg });
      eventBus.publish("workflow:failed", {
        runId,
        definitionId: def.id,
        error: errorMsg,
      }, { priority: "high", source: "workflow-engine" });
      break;
    case "retry_from":
      store.updateRunStatus(runId, "retrying");
      eventBus.publish("workflow:step_ready", {
        runId,
        stepId: strategy.stepId,
      }, { priority: "normal", source: "workflow-engine" });
      break;
  }
}

// ---------------------------------------------------------------------------
// Step skip
// ---------------------------------------------------------------------------

/** Mark a step as skipped. */
export function markStepSkipped(runId: string, stepId: string, store: WorkflowStore): void {
  const existingResult = store.getStepResult(runId, stepId);
  if (existingResult.ok && existingResult.value) {
    store.updateStepResult(existingResult.value.id, { status: "skipped" });
  }
}

// ---------------------------------------------------------------------------
// DAG validation
// ---------------------------------------------------------------------------

/** Validate that workflow steps form a valid DAG (no cycles, valid refs). */
export function validateDag(steps: readonly WorkflowStepDef[]): Result<void, EidolonError> {
  const stepIds = new Set(steps.map((s) => s.id));

  // Check for duplicate IDs
  if (stepIds.size !== steps.length) {
    return Err(createError(ErrorCode.CONFIG_INVALID, "Duplicate step IDs in workflow"));
  }

  // Check all dependsOn references exist
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (!stepIds.has(dep)) {
        return Err(createError(ErrorCode.CONFIG_INVALID, `Step "${step.id}" depends on unknown step "${dep}"`));
      }
    }
  }

  // Check for cycles via topological sort
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const dfs = (stepId: string): boolean => {
    if (visiting.has(stepId)) return true; // cycle
    if (visited.has(stepId)) return false;
    visiting.add(stepId);

    const step = steps.find((s) => s.id === stepId);
    if (step) {
      for (const dep of step.dependsOn) {
        if (dfs(dep)) return true;
      }
    }

    visiting.delete(stepId);
    visited.add(stepId);
    return false;
  };

  for (const step of steps) {
    if (dfs(step.id)) {
      return Err(createError(ErrorCode.CONFIG_INVALID, "Workflow DAG contains a cycle"));
    }
  }

  return Ok(undefined);
}
