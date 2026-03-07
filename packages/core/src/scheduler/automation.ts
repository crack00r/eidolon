/**
 * AutomationEngine -- Khoj-style scheduled automations.
 *
 * Parses natural language schedule descriptions into cron expressions and
 * structured automation tasks. Automations are stored as scheduled tasks with
 * action "automation" and payload containing the Claude Code prompt and
 * delivery channel.
 *
 * Example: "Every Monday at 9am, research TypeScript news and send me a summary"
 *   -> cron: "09:00:1", prompt: "Research TypeScript news and write a summary",
 *      deliverTo: "telegram"
 */

import type { Database } from "bun:sqlite";
import type { AutomationTask, EidolonError, ParsedAutomation, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";
import { deriveName, extractScheduleAndAction } from "./automation-parsing.ts";
import type { TaskScheduler } from "./scheduler.ts";

// ---------------------------------------------------------------------------
// Zod schemas for DB rows
// ---------------------------------------------------------------------------

const AutomationPayloadSchema = z.object({
  prompt: z.string(),
  deliverTo: z.string(),
  originalInput: z.string(),
});

// ---------------------------------------------------------------------------
// AutomationEngine
// ---------------------------------------------------------------------------

export class AutomationEngine {
  private readonly scheduler: TaskScheduler;
  private readonly logger: Logger;

  constructor(scheduler: TaskScheduler, _db: Database, logger: Logger) {
    this.scheduler = scheduler;
    this.logger = logger.child("automation");
  }

  /**
   * Parse a natural language automation description into a structured result.
   * Does not persist -- use create() for that.
   */
  parseNaturalLanguage(input: string, defaultChannel?: string): Result<ParsedAutomation, EidolonError> {
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
    const name = deriveName(actionText);
    const deliverTo = defaultChannel ?? "telegram";

    return Ok({ name, cron, prompt: actionText, deliverTo });
  }

  /**
   * Create an automation from natural language input.
   * Parses the input, creates a scheduled task, and returns the automation.
   */
  create(input: string, defaultChannel?: string): Result<AutomationTask, EidolonError> {
    const parseResult = this.parseNaturalLanguage(input, defaultChannel);
    if (!parseResult.ok) {
      return parseResult;
    }

    const parsed = parseResult.value;
    const payload = {
      prompt: parsed.prompt,
      deliverTo: parsed.deliverTo,
      originalInput: input,
    };

    const taskResult = this.scheduler.create({
      name: parsed.name,
      type: "recurring",
      cron: parsed.cron,
      action: "automation",
      payload,
    });

    if (!taskResult.ok) {
      return taskResult;
    }

    const task = taskResult.value;
    const automation: AutomationTask = {
      id: task.id,
      name: task.name,
      prompt: parsed.prompt,
      deliverTo: parsed.deliverTo,
      cron: parsed.cron,
      originalInput: input,
      enabled: task.enabled,
      lastRunAt: task.lastRunAt,
      nextRunAt: task.nextRunAt,
      createdAt: task.createdAt,
    };

    this.logger.info("create", `Automation created: "${parsed.name}" [${parsed.cron}]`, {
      automationId: automation.id,
    });
    return Ok(automation);
  }

  /**
   * List all automation tasks (those with action === "automation").
   */
  list(enabledOnly?: boolean): Result<AutomationTask[], EidolonError> {
    const listResult = this.scheduler.list(enabledOnly);
    if (!listResult.ok) {
      return listResult;
    }

    const automations: AutomationTask[] = [];
    for (const task of listResult.value) {
      if (task.action !== "automation") continue;

      const payloadResult = AutomationPayloadSchema.safeParse(task.payload);
      if (!payloadResult.success) continue;

      automations.push({
        id: task.id,
        name: task.name,
        prompt: payloadResult.data.prompt,
        deliverTo: payloadResult.data.deliverTo,
        cron: task.cron ?? "",
        originalInput: payloadResult.data.originalInput,
        enabled: task.enabled,
        lastRunAt: task.lastRunAt,
        nextRunAt: task.nextRunAt,
        createdAt: task.createdAt,
      });
    }

    return Ok(automations);
  }

  /**
   * Delete an automation by ID. Only deletes tasks with action === "automation".
   */
  delete(automationId: string): Result<void, EidolonError> {
    // Verify it's actually an automation task
    const getResult = this.scheduler.get(automationId);
    if (!getResult.ok) {
      return getResult;
    }
    if (!getResult.value) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Automation not found: ${automationId}`));
    }
    if (getResult.value.action !== "automation") {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Task ${automationId} is not an automation`));
    }

    return this.scheduler.delete(automationId);
  }

  /**
   * Get a single automation by ID.
   */
  get(automationId: string): Result<AutomationTask | null, EidolonError> {
    const getResult = this.scheduler.get(automationId);
    if (!getResult.ok) {
      return getResult;
    }
    if (!getResult.value || getResult.value.action !== "automation") {
      return Ok(null);
    }

    const task = getResult.value;
    const payloadResult = AutomationPayloadSchema.safeParse(task.payload);
    if (!payloadResult.success) {
      return Ok(null);
    }

    return Ok({
      id: task.id,
      name: task.name,
      prompt: payloadResult.data.prompt,
      deliverTo: payloadResult.data.deliverTo,
      cron: task.cron ?? "",
      originalInput: payloadResult.data.originalInput,
      enabled: task.enabled,
      lastRunAt: task.lastRunAt,
      nextRunAt: task.nextRunAt,
      createdAt: task.createdAt,
    });
  }
}

// Re-export parsing helpers for testing
export { deriveName, extractScheduleAndAction, parseDay, parseTime } from "./automation-parsing.ts";
