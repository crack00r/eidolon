/**
 * WorkflowStore -- CRUD for workflow definitions, runs, and step results.
 *
 * All data lives in operational.db. Uses parameterized queries exclusively.
 * Returns Result<T, EidolonError> for all operations.
 *
 * Row types and conversion helpers are in store-rows.ts.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { DefinitionRow, RunRow, StepResultRow } from "./store-rows.ts";
import { rowToDefinition, rowToRun, rowToStepResult, serializeContext } from "./store-rows.ts";
import type {
  StepResult,
  StepStatus,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowRun,
  WorkflowStatus,
} from "./types.ts";
import { MAX_WORKFLOW_DEFINITIONS, MAX_WORKFLOW_RUNS, WorkflowDefinitionSchema } from "./types.ts";

// ---------------------------------------------------------------------------
// Public: WorkflowStore
// ---------------------------------------------------------------------------

export class WorkflowStore {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  // -- Definitions ----------------------------------------------------------

  createDefinition(def: WorkflowDefinition): Result<WorkflowDefinition, EidolonError> {
    try {
      const parsed = WorkflowDefinitionSchema.safeParse(def);
      if (!parsed.success) {
        return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid workflow definition: ${parsed.error.message}`));
      }
      const valid = parsed.data;
      const now = Date.now();

      // Wrap count+insert in a transaction to prevent TOCTOU race
      const insertInTransaction = this.db.transaction(() => {
        const count = this.db.query("SELECT COUNT(*) as c FROM workflow_definitions").get() as {
          c: number;
        };
        if (count.c >= MAX_WORKFLOW_DEFINITIONS) {
          throw new Error(`__LIMIT_EXCEEDED__`);
        }

        this.db
          .query(
            `INSERT INTO workflow_definitions (id, name, description, trigger_type, trigger_config, steps, on_failure, max_duration_ms, enabled, created_by, created_at, updated_at, metadata)
           VALUES ($id, $name, $description, $triggerType, $triggerConfig, $steps, $onFailure, $maxDurationMs, 1, $createdBy, $createdAt, $updatedAt, $metadata)`,
          )
          .run({
            $id: valid.id,
            $name: valid.name,
            $description: valid.description,
            $triggerType: valid.trigger.type,
            $triggerConfig: JSON.stringify(valid.trigger),
            $steps: JSON.stringify(valid.steps),
            $onFailure: JSON.stringify(valid.onFailure),
            $maxDurationMs: valid.maxDurationMs,
            $createdBy: valid.createdBy,
            $createdAt: valid.createdAt || now,
            $updatedAt: now,
            $metadata: JSON.stringify(valid.metadata),
          });
      });

      try {
        insertInTransaction();
      } catch (txErr: unknown) {
        if (txErr instanceof Error && txErr.message === "__LIMIT_EXCEEDED__") {
          return Err(
            createError(ErrorCode.INVALID_INPUT, `Maximum ${MAX_WORKFLOW_DEFINITIONS} workflow definitions reached`),
          );
        }
        throw txErr;
      }

      this.logger.info("workflow-store", `Created workflow definition: ${valid.id}`);
      return Ok(valid);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to create definition: ${msg}`, err));
    }
  }

  getDefinition(id: string): Result<WorkflowDefinition, EidolonError> {
    try {
      const row = this.db
        .query("SELECT * FROM workflow_definitions WHERE id = $id")
        .get({ $id: id }) as DefinitionRow | null;
      if (!row) {
        return Err(createError(ErrorCode.INVALID_INPUT, `Workflow definition not found: ${id}`));
      }
      return Ok(rowToDefinition(row));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get definition: ${msg}`, err));
    }
  }

  listDefinitions(): Result<readonly WorkflowDefinition[], EidolonError> {
    try {
      const rows = this.db
        .query("SELECT * FROM workflow_definitions WHERE enabled = 1 ORDER BY created_at DESC")
        .all() as DefinitionRow[];
      return Ok(rows.map((r) => rowToDefinition(r)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to list definitions: ${msg}`, err));
    }
  }

  deleteDefinition(id: string): Result<void, EidolonError> {
    try {
      const result = this.db.query("DELETE FROM workflow_definitions WHERE id = $id").run({ $id: id });
      if (result.changes === 0) {
        return Err(createError(ErrorCode.INVALID_INPUT, `Workflow definition not found: ${id}`));
      }
      return Ok(undefined);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete definition: ${msg}`, err));
    }
  }

  // -- Runs -----------------------------------------------------------------

  createRun(id: string, definitionId: string, triggerPayload: unknown): Result<WorkflowRun, EidolonError> {
    try {
      const now = Date.now();
      const context: WorkflowContext = {
        runId: id,
        definitionId,
        stepOutputs: new Map(),
        triggerPayload,
        variables: {},
      };

      // Wrap count+insert in a transaction to prevent TOCTOU race
      const insertInTransaction = this.db.transaction(() => {
        const count = this.db.query("SELECT COUNT(*) as c FROM workflow_runs").get() as { c: number };
        if (count.c >= MAX_WORKFLOW_RUNS) {
          throw new Error("__LIMIT_EXCEEDED__");
        }

        this.db
          .query(
            `INSERT INTO workflow_runs (id, definition_id, status, context, current_step_id, started_at, completed_at, error, trigger_payload, created_at)
           VALUES ($id, $defId, 'pending', $context, NULL, NULL, NULL, NULL, $triggerPayload, $createdAt)`,
          )
          .run({
            $id: id,
            $defId: definitionId,
            $context: serializeContext(context),
            $triggerPayload: JSON.stringify(triggerPayload ?? {}),
            $createdAt: now,
          });
      });

      try {
        insertInTransaction();
      } catch (txErr: unknown) {
        if (txErr instanceof Error && txErr.message === "__LIMIT_EXCEEDED__") {
          return Err(createError(ErrorCode.INVALID_INPUT, `Maximum ${MAX_WORKFLOW_RUNS} workflow runs reached`));
        }
        throw txErr;
      }

      const run: WorkflowRun = {
        id,
        definitionId,
        status: "pending",
        context,
        currentStepId: null,
        startedAt: null,
        completedAt: null,
        error: null,
        triggerPayload: triggerPayload ?? {},
        createdAt: now,
      };

      return Ok(run);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to create run: ${msg}`, err));
    }
  }

  getRun(id: string): Result<WorkflowRun, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM workflow_runs WHERE id = $id").get({ $id: id }) as RunRow | null;
      if (!row) {
        return Err(createError(ErrorCode.INVALID_INPUT, `Workflow run not found: ${id}`));
      }
      return Ok(rowToRun(row));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get run: ${msg}`, err));
    }
  }

  updateRunStatus(
    id: string,
    status: WorkflowStatus,
    updates?: { currentStepId?: string | null; error?: string | null; context?: WorkflowContext },
  ): Result<void, EidolonError> {
    try {
      const now = Date.now();
      const completedAt = status === "completed" || status === "failed" || status === "cancelled" ? now : null;
      const startedAt = status === "running" ? now : null;

      // For currentStepId and error, distinguish between "not provided" (keep existing)
      // and "explicitly set to null" (clear it). Use conditional SQL expressions:
      // only include the SET clause when the caller provides the field.
      const hasCurrentStepId = updates !== undefined && "currentStepId" in updates;
      const hasError = updates !== undefined && "error" in updates;

      this.db
        .query(
          `UPDATE workflow_runs SET
           status = $status,
           current_step_id = ${hasCurrentStepId ? "$currentStepId" : "current_step_id"},
           completed_at = COALESCE($completedAt, completed_at),
           started_at = COALESCE(started_at, $startedAt),
           error = ${hasError ? "$error" : "error"},
           context = COALESCE($context, context)
         WHERE id = $id`,
        )
        .run({
          $id: id,
          $status: status,
          $currentStepId: hasCurrentStepId ? (updates?.currentStepId ?? null) : null,
          $completedAt: completedAt,
          $startedAt: startedAt,
          $error: hasError ? (updates?.error ?? null) : null,
          $context: updates?.context ? serializeContext(updates.context) : null,
        });
      return Ok(undefined);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update run: ${msg}`, err));
    }
  }

  getRunsByStatus(status: WorkflowStatus): Result<readonly WorkflowRun[], EidolonError> {
    try {
      const rows = this.db
        .query("SELECT * FROM workflow_runs WHERE status = $status ORDER BY created_at DESC")
        .all({ $status: status }) as RunRow[];
      return Ok(rows.map((r) => rowToRun(r)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get runs by status: ${msg}`, err));
    }
  }

  countActiveRuns(): Result<number, EidolonError> {
    try {
      const row = this.db
        .query("SELECT COUNT(*) as c FROM workflow_runs WHERE status IN ('pending', 'running', 'waiting', 'retrying')")
        .get() as { c: number };
      return Ok(row.c);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to count active runs: ${msg}`, err));
    }
  }

  // -- Step Results ---------------------------------------------------------

  createStepResult(result: StepResult): Result<void, EidolonError> {
    try {
      this.db
        .query(
          `INSERT INTO workflow_step_results (id, run_id, step_id, status, output, error, attempt, started_at, completed_at, tokens_used)
         VALUES ($id, $runId, $stepId, $status, $output, $error, $attempt, $startedAt, $completedAt, $tokensUsed)`,
        )
        .run({
          $id: result.id,
          $runId: result.runId,
          $stepId: result.stepId,
          $status: result.status,
          $output: result.output != null ? JSON.stringify(result.output) : null,
          $error: result.error,
          $attempt: result.attempt,
          $startedAt: result.startedAt,
          $completedAt: result.completedAt,
          $tokensUsed: result.tokensUsed,
        });
      return Ok(undefined);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to create step result: ${msg}`, err));
    }
  }

  updateStepResult(
    id: string,
    updates: { status: StepStatus; output?: unknown; error?: string | null; tokensUsed?: number },
  ): Result<void, EidolonError> {
    try {
      const now = Date.now();
      // Only set completed_at when the step reaches a terminal state
      const isTerminal = updates.status === "completed" || updates.status === "failed";
      this.db
        .query(
          `UPDATE workflow_step_results
         SET status = $status, output = $output, error = $error,
             completed_at = ${isTerminal ? "$completedAt" : "completed_at"},
             started_at = CASE WHEN $status = 'running' AND started_at IS NULL THEN $completedAt ELSE started_at END,
             tokens_used = COALESCE($tokensUsed, tokens_used)
         WHERE id = $id`,
        )
        .run({
          $id: id,
          $status: updates.status,
          $output: updates.output !== undefined ? JSON.stringify(updates.output) : null,
          $error: updates.error ?? null,
          $completedAt: now,
          $tokensUsed: updates.tokensUsed ?? null,
        });
      return Ok(undefined);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update step result: ${msg}`, err));
    }
  }

  getStepResults(runId: string): Result<readonly StepResult[], EidolonError> {
    try {
      const rows = this.db
        .query("SELECT * FROM workflow_step_results WHERE run_id = $runId ORDER BY started_at ASC")
        .all({ $runId: runId }) as StepResultRow[];
      return Ok(rows.map((r) => rowToStepResult(r)));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get step results: ${msg}`, err));
    }
  }

  /** Delete all step results for a specific step in a run (used before retry to prevent accumulation). */
  deleteStepResultsForStep(runId: string, stepId: string): Result<void, EidolonError> {
    try {
      this.db
        .query("DELETE FROM workflow_step_results WHERE run_id = $runId AND step_id = $stepId")
        .run({ $runId: runId, $stepId: stepId });
      return Ok(undefined);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete step results: ${msg}`, err));
    }
  }

  getStepResult(runId: string, stepId: string): Result<StepResult | null, EidolonError> {
    try {
      const row = this.db
        .query(
          "SELECT * FROM workflow_step_results WHERE run_id = $runId AND step_id = $stepId ORDER BY attempt DESC LIMIT 1",
        )
        .get({ $runId: runId, $stepId: stepId }) as StepResultRow | null;
      return Ok(row ? rowToStepResult(row) : null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get step result: ${msg}`, err));
    }
  }

  cleanupOldWorkflows(olderThanDays: number): Result<number, EidolonError> {
    try {
      const cutoffMs = Date.now() - olderThanDays * 86_400_000;

      const runIds = this.db
        .query(
          "SELECT id FROM workflow_runs WHERE status IN ('completed', 'failed', 'cancelled') AND completed_at < $cutoff",
        )
        .all({ $cutoff: cutoffMs }) as Array<{ id: string }>;

      if (runIds.length === 0) {
        return Ok(0);
      }

      const ids = runIds.map((r) => r.id);
      const placeholders = ids.map(() => "?").join(", ");

      const deleteInTransaction = this.db.transaction(() => {
        this.db.query(`DELETE FROM workflow_step_results WHERE run_id IN (${placeholders})`).run(...ids);
        return this.db.query(`DELETE FROM workflow_runs WHERE id IN (${placeholders})`).run(...ids);
      });
      const result = deleteInTransaction();

      this.logger.info("workflow-store", `Cleaned up ${result.changes} old workflow runs`);
      return Ok(result.changes);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to cleanup old workflows: ${msg}`, err));
    }
  }
}
