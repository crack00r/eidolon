// TaskScheduler -- manages scheduled tasks (cron-like recurring, one-off, conditional).
//
// Persists tasks to the operational database `scheduled_tasks` table.
// Supports simple cron formats: "HH:MM" (daily), "*/N" (every N minutes),
// "HH:MM:dow" (specific day of week, 0=Sun..6=Sat).

import type { Database } from "bun:sqlite";
import type { EidolonError, Result, ScheduledTask, ScheduleType } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

export interface CreateTaskInput {
  readonly name: string;
  readonly type: ScheduleType;
  readonly cron?: string;
  readonly runAt?: number;
  readonly condition?: string;
  readonly action: string;
  readonly payload?: Record<string, unknown>;
}

interface TaskRow {
  id: string;
  name: string;
  type: string;
  cron: string | null;
  run_at: number | null;
  condition: string | null;
  action: string;
  payload: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

function rowToTask(row: TaskRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ScheduleType,
    cron: row.cron ?? undefined,
    runAt: row.run_at ?? undefined,
    condition: row.condition ?? undefined,
    action: row.action,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    createdAt: row.created_at,
  };
}

export class TaskScheduler {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("scheduler");
  }

  /** Create a new scheduled task. */
  create(input: CreateTaskInput): Result<ScheduledTask, EidolonError> {
    try {
      const id = crypto.randomUUID();
      const now = Date.now();
      const payload = JSON.stringify(input.payload ?? {});
      const nextRunAt = this.computeInitialNextRun(input);

      this.db
        .query(
          `INSERT INTO scheduled_tasks (id, name, type, cron, run_at, condition, action, payload, enabled, next_run_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          id,
          input.name,
          input.type,
          input.cron ?? null,
          input.runAt ?? null,
          input.condition ?? null,
          input.action,
          payload,
          nextRunAt,
          now,
        );

      const task: ScheduledTask = {
        id,
        name: input.name,
        type: input.type,
        cron: input.cron,
        runAt: input.runAt,
        condition: input.condition,
        action: input.action,
        payload: input.payload ?? {},
        enabled: true,
        nextRunAt: nextRunAt ?? undefined,
        createdAt: now,
      };

      this.logger.info("create", `Task created: ${input.name} (${input.type})`, { taskId: id });
      return Ok(task);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to create task: ${input.name}`, cause));
    }
  }

  /** Get a task by ID. */
  get(id: string): Result<ScheduledTask | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as TaskRow | null;
      return Ok(row ? rowToTask(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get task: ${id}`, cause));
    }
  }

  /** List all tasks, optionally filtering to enabled only. */
  list(enabledOnly?: boolean): Result<ScheduledTask[], EidolonError> {
    try {
      const query = enabledOnly
        ? "SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY next_run_at ASC"
        : "SELECT * FROM scheduled_tasks ORDER BY created_at DESC";
      const rows = this.db.query(query).all() as TaskRow[];
      return Ok(rows.map(rowToTask));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list tasks", cause));
    }
  }

  /** Get the next task that is due to run (nextRunAt <= now). */
  getNextDue(): Result<ScheduledTask | null, EidolonError> {
    try {
      const now = Date.now();
      const row = this.db
        .query(
          "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 1",
        )
        .get(now) as TaskRow | null;
      return Ok(row ? rowToTask(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get next due task", cause));
    }
  }

  /** Get all tasks that are due. */
  getDueTasks(): Result<ScheduledTask[], EidolonError> {
    try {
      const now = Date.now();
      const rows = this.db
        .query(
          "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC",
        )
        .all(now) as TaskRow[];
      return Ok(rows.map(rowToTask));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get due tasks", cause));
    }
  }

  /** Mark a task as executed. Updates lastRunAt and computes nextRunAt. */
  markExecuted(taskId: string): Result<void, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId) as TaskRow | null;
      if (!row) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Task not found: ${taskId}`));
      }

      const now = Date.now();
      const task = rowToTask(row);

      if (task.type === "once") {
        // One-off tasks are disabled after execution
        this.db
          .query("UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = NULL, enabled = 0 WHERE id = ?")
          .run(now, taskId);
        this.logger.info("markExecuted", `One-off task completed and disabled: ${task.name}`, { taskId });
      } else if (task.type === "recurring" && task.cron) {
        // Recurring tasks compute the next run time
        const nextRunAt = TaskScheduler.computeNextRun(task.cron, now);
        this.db
          .query("UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?")
          .run(now, nextRunAt, taskId);
        this.logger.info("markExecuted", `Recurring task executed: ${task.name}, next at ${nextRunAt}`, { taskId });
      } else {
        // Conditional tasks: just update lastRunAt, keep nextRunAt as-is
        this.db.query("UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?").run(now, taskId);
        this.logger.info("markExecuted", `Task executed: ${task.name}`, { taskId });
      }

      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to mark task executed: ${taskId}`, cause));
    }
  }

  /** Enable or disable a task. */
  setEnabled(taskId: string, enabled: boolean): Result<void, EidolonError> {
    try {
      const changes = this.db.query("UPDATE scheduled_tasks SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, taskId);
      if (changes.changes === 0) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Task not found: ${taskId}`));
      }
      this.logger.info("setEnabled", `Task ${enabled ? "enabled" : "disabled"}: ${taskId}`, { taskId, enabled });
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to set enabled for task: ${taskId}`, cause));
    }
  }

  /** Delete a task. */
  delete(taskId: string): Result<void, EidolonError> {
    try {
      const changes = this.db.query("DELETE FROM scheduled_tasks WHERE id = ?").run(taskId);
      if (changes.changes === 0) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Task not found: ${taskId}`));
      }
      this.logger.info("delete", `Task deleted: ${taskId}`, { taskId });
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete task: ${taskId}`, cause));
    }
  }

  // Compute nextRunAt for a recurring task based on its cron string.
  //
  // Supported formats:
  // - "HH:MM"     -- run daily at this time
  // - "*/N"       -- run every N minutes
  // - "HH:MM:dow" -- run at time on specific day (0=Sun..6=Sat)
  static computeNextRun(cron: string, after?: number): number {
    const now = after ?? Date.now();

    // "HH:MM" format -- next occurrence of this time
    if (/^\d{2}:\d{2}$/.test(cron)) {
      const [hours, minutes] = cron.split(":").map(Number) as [number, number];
      const next = new Date(now);
      next.setHours(hours, minutes, 0, 0);
      if (next.getTime() <= now) {
        next.setDate(next.getDate() + 1);
      }
      return next.getTime();
    }

    // "*/N" format -- every N minutes from now
    if (/^\*\/\d+$/.test(cron)) {
      const minutes = Number.parseInt(cron.slice(2), 10);
      return now + minutes * 60_000;
    }

    // "HH:MM:dow" format -- at time on specific day of week
    if (/^\d{2}:\d{2}:\d$/.test(cron)) {
      const parts = cron.split(":").map(Number) as [number, number, number];
      const [hours, minutes, dow] = parts;
      const next = new Date(now);
      next.setHours(hours, minutes, 0, 0);

      // Advance to the target day of week
      const currentDow = next.getDay();
      let daysAhead = dow - currentDow;
      if (daysAhead < 0 || (daysAhead === 0 && next.getTime() <= now)) {
        daysAhead += 7;
      }
      next.setDate(next.getDate() + daysAhead);

      return next.getTime();
    }

    // Fallback: 1 hour from now
    return now + 3_600_000;
  }

  /** Compute the initial nextRunAt based on task input. */
  private computeInitialNextRun(input: CreateTaskInput): number | null {
    if (input.type === "once" && input.runAt) {
      return input.runAt;
    }
    if (input.type === "recurring" && input.cron) {
      return TaskScheduler.computeNextRun(input.cron);
    }
    // Conditional tasks don't have a fixed nextRunAt
    return null;
  }
}
