/**
 * Row types and conversion helpers for WorkflowStore.
 * Extracted from store.ts to keep files under 300 lines.
 */

import { z } from "zod";
import type { StepResult, WorkflowContext, WorkflowDefinition, WorkflowRun } from "./types.ts";
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

/** Parse JSON from a DB column, logging a warning and returning fallback on failure. */
function safeParseJson<T>(column: string, json: string, fallback: T, rowId: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Use console.error as a last resort -- store-rows has no logger dependency.
    // This is acceptable because malformed JSON in the DB is a data integrity issue
    // that should be visible in logs.
    console.error(`[store-rows] Malformed JSON in column '${column}' for row ${rowId}: ${msg}`);
    return fallback;
  }
}

export function rowToDefinition(row: DefinitionRow): WorkflowDefinition {
  const trigger = safeParseJson<WorkflowDefinition["trigger"]>(
    "trigger_config",
    row.trigger_config,
    { type: "manual" } as WorkflowDefinition["trigger"],
    row.id,
  );
  const steps = safeParseJson<WorkflowDefinition["steps"]>("steps", row.steps, [], row.id);
  const onFailure = safeParseJson<WorkflowDefinition["onFailure"]>(
    "on_failure",
    row.on_failure,
    { type: "abort" },
    row.id,
  );
  const metadata = safeParseJson<Record<string, unknown>>("metadata", row.metadata, {}, row.id);

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
  const triggerPayload = safeParseJson<unknown>("trigger_payload", row.trigger_payload, {}, row.id);
  return {
    id: row.id,
    definitionId: row.definition_id,
    status,
    context: deserializeContext(row.context, row.id, row.definition_id, row.trigger_payload),
    currentStepId: row.current_step_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    triggerPayload,
    createdAt: row.created_at,
  };
}

export function rowToStepResult(row: StepResultRow): StepResult {
  const status = StepStatusSchema.parse(row.status);
  const output: unknown = row.output ? safeParseJson<unknown>("output", row.output, null, row.id) : null;
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    status,
    output,
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
