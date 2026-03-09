// TaskScheduler -- manages scheduled tasks (cron-like recurring, one-off, conditional).
//
// Persists tasks to the operational database `scheduled_tasks` table.
// Supports simple cron formats: "HH:MM" (daily), "*/N" (every N minutes),
// "HH:MM:dow" (specific day of week, 0=Sun..6=Sat).

import type { Database } from "bun:sqlite";
import type { EidolonError, Result, ScheduledTask, ScheduleType } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";
import {
  computeNextDowInTimezone,
  computeNextTimeInTimezone,
  validateCronExpression,
  validateTimezone,
} from "./cron-utils.ts";

export { validateCronExpression } from "./cron-utils.ts";

export interface CreateTaskInput {
  readonly name: string;
  readonly type: ScheduleType;
  readonly cron?: string;
  readonly runAt?: number;
  readonly condition?: string;
  readonly action: string;
  readonly payload?: Record<string, unknown>;
  /** IANA timezone identifier (e.g. "Europe/Berlin"). Defaults to local time. */
  readonly timezone?: string;
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
  timezone: string | null;
}

/** Zod schema for validating task payload from DB. */
const TaskPayloadSchema = z.record(z.unknown());

/** Zod schema for validating schedule type from DB. */
const ScheduleTypeSchema = z.enum(["once", "recurring", "conditional"]);

function rowToTask(row: TaskRow, logger?: Logger): ScheduledTask {
  // Safely parse JSON payload from DB -- corrupted rows get an empty payload
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.payload);
    const validated = TaskPayloadSchema.safeParse(parsed);
    if (validated.success) {
      payload = validated.data;
    }
  } catch {
    // Corrupted JSON in DB -- use empty payload rather than crashing
    if (logger) {
      logger.warn("rowToTask", `Failed to parse task payload for task "${row.id}"`);
    }
  }

  // Validate schedule type from DB
  const typeResult = ScheduleTypeSchema.safeParse(row.type);
  const type: ScheduleType = typeResult.success ? typeResult.data : "once";

  return {
    id: row.id,
    name: row.name,
    type,
    cron: row.cron ?? undefined,
    runAt: row.run_at ?? undefined,
    condition: row.condition ?? undefined,
    action: row.action,
    payload,
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at ?? undefined,
    createdAt: row.created_at,
    timezone: row.timezone ?? undefined,
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
    // Validate cron expression if provided
    if (input.cron) {
      const cronError = validateCronExpression(input.cron);
      if (cronError) {
        return Err(createError(ErrorCode.CONFIG_INVALID, cronError));
      }
    }

    // Validate timezone if provided
    if (input.timezone) {
      const tzError = validateTimezone(input.timezone);
      if (tzError) {
        return Err(createError(ErrorCode.CONFIG_INVALID, tzError));
      }
    }

    try {
      const id = crypto.randomUUID();
      const now = Date.now();
      const payload = JSON.stringify(input.payload ?? {});
      const nextRunAt = this.computeInitialNextRun(input);

      this.db
        .query(
          `INSERT INTO scheduled_tasks (id, name, type, cron, run_at, condition, action, payload, enabled, next_run_at, created_at, timezone)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
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
          input.timezone ?? null,
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
        timezone: input.timezone,
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
      return Ok(row ? rowToTask(row, this.logger) : null);
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
      return Ok(rows.map((r) => rowToTask(r, this.logger)));
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
      return Ok(row ? rowToTask(row, this.logger) : null);
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
      return Ok(rows.map((r) => rowToTask(r, this.logger)));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to get due tasks", cause));
    }
  }

  /** Mark a task as executed. Updates lastRunAt and computes nextRunAt. */
  markExecuted(taskId: string): Result<void, EidolonError> {
    try {
      // Wrap SELECT + UPDATE in a transaction to prevent TOCTOU race conditions
      const txn = this.db.transaction(() => {
        const row = this.db.query("SELECT * FROM scheduled_tasks WHERE id = ?").get(taskId) as TaskRow | null;
        if (!row) {
          return { found: false as const };
        }

        const now = Date.now();
        const task = rowToTask(row, this.logger);

        if (task.type === "once") {
          // One-off tasks are disabled after execution
          this.db
            .query("UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = NULL, enabled = 0 WHERE id = ?")
            .run(now, taskId);
          this.logger.info("markExecuted", `One-off task completed and disabled: ${task.name}`, { taskId });
        } else if (task.type === "recurring" && task.cron) {
          // Recurring tasks compute the next run time (timezone-aware)
          const nextRunAt = TaskScheduler.computeNextRun(task.cron, now, task.timezone);
          this.db
            .query("UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?")
            .run(now, nextRunAt, taskId);
          this.logger.info("markExecuted", `Recurring task executed: ${task.name}, next at ${nextRunAt}`, { taskId });
        } else {
          // Conditional tasks: just update lastRunAt, keep nextRunAt as-is
          this.db.query("UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?").run(now, taskId);
          this.logger.info("markExecuted", `Task executed: ${task.name}`, { taskId });
        }

        return { found: true as const };
      });

      const result = txn();
      if (!result.found) {
        return Err(createError(ErrorCode.DB_QUERY_FAILED, `Task not found: ${taskId}`));
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
  //
  // When timezone is provided, HH:MM values are interpreted in that timezone.
  // The "*/N" format is timezone-independent (always relative to `after`).
  static computeNextRun(cron: string, after?: number, timezone?: string, logger?: Logger): number {
    const now = after ?? Date.now();

    // "HH:MM" format -- next occurrence of this time
    if (/^\d{2}:\d{2}$/.test(cron)) {
      const [hours, minutes] = cron.split(":").map(Number) as [number, number];
      return computeNextTimeInTimezone(hours, minutes, now, timezone);
    }

    // "*/N" format -- every N minutes from now (timezone-independent)
    if (/^\*\/\d+$/.test(cron)) {
      const intervalMinutes = Number.parseInt(cron.slice(2), 10);
      return now + intervalMinutes * 60_000;
    }

    // "HH:MM:dow" format -- at time on specific day of week
    if (/^\d{2}:\d{2}:\d$/.test(cron)) {
      const parts = cron.split(":").map(Number) as [number, number, number];
      const [hours, mins, dow] = parts;
      return computeNextDowInTimezone(hours, mins, dow, now, timezone);
    }

    // "HH:MM:dow1-dow2" format -- at time on day-of-week range (e.g., "09:00:1-5" for weekdays)
    if (/^\d{2}:\d{2}:\d-\d$/.test(cron)) {
      const timePart = cron.slice(0, 5);
      const [hours, mins] = timePart.split(":").map(Number) as [number, number];
      const dowPart = cron.slice(6); // e.g., "1-5"
      const [startDowStr, endDowStr] = dowPart.split("-");
      const startDow = Number.parseInt(startDowStr ?? "0", 10);
      const endDow = Number.parseInt(endDowStr ?? "0", 10);

      // Find the nearest matching day in the range
      let earliest = Number.POSITIVE_INFINITY;
      for (let dow = startDow; dow <= endDow; dow++) {
        const candidate = computeNextDowInTimezone(hours, mins, dow, now, timezone);
        if (candidate < earliest) {
          earliest = candidate;
        }
      }
      return earliest;
    }

    // Fallback: 1 hour from now -- log warning for unrecognized cron expression
    if (logger) {
      logger.warn(
        "computeNextRun",
        `Unrecognized cron expression "${cron}", falling back to 1 hour from now`,
      );
    }
    return now + 3_600_000;
  }

  /**
   * Create a scheduled task from a natural language description.
   * Delegates parsing to AutomationEngine and stores as an automation task.
   */
  async createFromNaturalLanguage(input: string, defaultChannel?: string): Promise<Result<ScheduledTask, EidolonError>> {
    // Lazy import to avoid circular dependency at module load time
    const { extractScheduleAndAction, deriveName } = (await import("./automation.ts")) as {
      extractScheduleAndAction: (input: string) => { cron: string; actionText: string } | null;
      deriveName: (actionText: string) => string;
    };

    const result = extractScheduleAndAction(input);
    if (!result) {
      return Err(
        createError(
          ErrorCode.CONFIG_INVALID,
          `Could not parse schedule from input: "${input}". ` +
            'Try formats like "every Monday at 9am, do X" or "daily at 8am, do Y".',
        ),
      );
    }

    const { cron, actionText } = result;
    return this.create({
      name: deriveName(actionText),
      type: "recurring",
      cron,
      action: "automation",
      payload: {
        prompt: actionText,
        deliverTo: defaultChannel ?? "telegram",
        originalInput: input,
      },
    });
  }

  /** Compute the initial nextRunAt based on task input. */
  private computeInitialNextRun(input: CreateTaskInput): number | null {
    if (input.type === "once" && input.runAt) {
      return input.runAt;
    }
    if (input.type === "recurring" && input.cron) {
      return TaskScheduler.computeNextRun(input.cron, undefined, input.timezone);
    }
    // Conditional tasks don't have a fixed nextRunAt
    return null;
  }
}
