/**
 * Row types and conversion helpers for WorkflowStore.
 * Extracted from store.ts to keep files under 300 lines.
 */

import { z } from "zod";
import type {
  StepResult,
  StepStatus,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStatus,
} from "./types.ts";
import { STEP_STATUSES, WORKFLOW_STATUSES } from "./types.ts";

/** Zod schema for validating workflow status from DB. */
const WorkflowStatusSchema = z.enum(WORKFLOW_STATUSES);

/** Zod schema for validating step status from DB. */
const StepStatusSchema = z.enum(STEP_STATUSES);

// ---------------------------------------------------------------------------
// DB row shapes (what SQLite returns)
// ---------------------------------------------------------------------------

export interface DefinitionRow {
  id: string;
  name: string;
  description: string;
  trigger_type: string;
  trigger_config: string;
  steps: string;
  on_failure: string;
  max_duration_ms: number;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  metadata: string;
}

export interface RunRow {
  id: string;
  definition_id: string;
  status: string;
  context: string;
  current_step_id: string | null;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  trigger_payload: string;
  created_at: number;
}

export interface StepResultRow {
  id: string;
  run_id: string;
  step_id: string;
  status: string;
  output: string | null;
  error: string | null;
  attempt: number;
  started_at: number | null;
  completed_at: number | null;
  tokens_used: number;
}

// ---------------------------------------------------------------------------
// Row-to-model conversion helpers
// ---------------------------------------------------------------------------

export function rowToDefinition(row: DefinitionRow): WorkflowDefinition {
  let trigger: WorkflowDefinition["trigger"];
  try {
    trigger = JSON.parse(row.trigger_config) as WorkflowDefinition["trigger"];
  } catch {
    trigger = { type: "manual" } as WorkflowDefinition["trigger"];
  }

  let steps: WorkflowDefinition["steps"];
  try {
    steps = JSON.parse(row.steps) as WorkflowDefinition["steps"];
  } catch {
    steps = [];
  }

  let onFailure: WorkflowDefinition["onFailure"];
  try {
    onFailure = JSON.parse(row.on_failure) as WorkflowDefinition["onFailure"];
  } catch {
    onFailure = { type: "abort" };
  }

  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(row.metadata) as Record<string, unknown>;
  } catch {
    metadata = {};
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    trigger,
    steps,
    onFailure,
    createdAt: row.created_at,
    createdBy: row.created_by,
    maxDurationMs: row.max_duration_ms,
    metadata,
  };
}

export function rowToRun(row: RunRow): WorkflowRun {
  const status = WorkflowStatusSchema.parse(row.status);
  return {
    id: row.id,
    definitionId: row.definition_id,
    status,
    context: deserializeContext(row.context, row.id, row.definition_id, row.trigger_payload),
    currentStepId: row.current_step_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    triggerPayload: JSON.parse(row.trigger_payload),
    createdAt: row.created_at,
  };
}

export function rowToStepResult(row: StepResultRow): StepResult {
  const status = StepStatusSchema.parse(row.status);
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    status,
    output: row.output ? JSON.parse(row.output) : null,
    error: row.error,
    attempt: row.attempt,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    tokensUsed: row.tokens_used,
  };
}

// ---------------------------------------------------------------------------
// Context serialization
// ---------------------------------------------------------------------------

export function serializeContext(ctx: WorkflowContext): string {
  const obj = {
    stepOutputs: Object.fromEntries(ctx.stepOutputs),
    variables: ctx.variables,
  };
  return JSON.stringify(obj);
}

export function deserializeContext(
  json: string,
  runId: string,
  definitionId: string,
  triggerPayloadJson: string,
): WorkflowContext {
  const parsed = JSON.parse(json) as { stepOutputs: Record<string, unknown>; variables: Record<string, unknown> };
  return {
    runId,
    definitionId,
    stepOutputs: new Map(Object.entries(parsed.stepOutputs ?? {})),
    triggerPayload: JSON.parse(triggerPayloadJson),
    variables: parsed.variables ?? {},
  };
}
