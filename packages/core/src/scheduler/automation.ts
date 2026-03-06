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
// Natural language schedule patterns
// ---------------------------------------------------------------------------

interface SchedulePattern {
  readonly pattern: RegExp;
  readonly extract: (match: RegExpMatchArray) => string;
}

const HOUR_MAP: Record<string, number> = {
  midnight: 0,
  "1am": 1,
  "2am": 2,
  "3am": 3,
  "4am": 4,
  "5am": 5,
  "6am": 6,
  "7am": 7,
  "8am": 8,
  "9am": 9,
  "10am": 10,
  "11am": 11,
  noon: 12,
  "12pm": 12,
  "1pm": 13,
  "2pm": 14,
  "3pm": 15,
  "4pm": 16,
  "5pm": 17,
  "6pm": 18,
  "7pm": 19,
  "8pm": 20,
  "9pm": 21,
  "10pm": 22,
  "11pm": 23,
};

const DAY_MAP: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * Parse an informal time string like "9am", "14:30", "noon", "9:30pm" into HH:MM.
 */
function parseTime(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();

  // Check named times
  if (trimmed in HOUR_MAP) {
    const h = HOUR_MAP[trimmed] as number;
    return `${String(h).padStart(2, "0")}:00`;
  }

  // "9:30am", "10:15pm", "2:00am"
  const amPmColonMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (amPmColonMatch) {
    let hours = Number.parseInt(amPmColonMatch[1] as string, 10);
    const minutes = Number.parseInt(amPmColonMatch[2] as string, 10);
    const period = amPmColonMatch[3] as string;
    if (period === "pm" && hours < 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  // "9am", "11pm" (without minutes)
  const amPmMatch = trimmed.match(/^(\d{1,2})\s*(am|pm)$/);
  if (amPmMatch) {
    let hours = Number.parseInt(amPmMatch[1] as string, 10);
    const period = amPmMatch[2] as string;
    if (period === "pm" && hours < 12) hours += 12;
    if (period === "am" && hours === 12) hours = 0;
    return `${String(hours).padStart(2, "0")}:00`;
  }

  // "14:30", "09:00" (24h format)
  const hhmmMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmmMatch) {
    const hours = Number.parseInt(hhmmMatch[1] as string, 10);
    const minutes = Number.parseInt(hhmmMatch[2] as string, 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    }
  }

  return null;
}

/**
 * Parse a day-of-week string into the cron dow number (0=Sun..6=Sat).
 */
function parseDay(raw: string): number | null {
  const trimmed = raw.trim().toLowerCase();
  // Remove trailing 's' for plurals: "mondays" -> "monday"
  const singular = trimmed.endsWith("s") ? trimmed.slice(0, -1) : trimmed;
  return DAY_MAP[singular] ?? null;
}

// Schedule extraction patterns ordered by specificity
const SCHEDULE_PATTERNS: SchedulePattern[] = [
  // "every <day> at <time>"
  {
    pattern:
      /every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s?\s+at\s+(\S+)/i,
    extract: (m) => {
      const day = parseDay(m[1] as string);
      const time = parseTime(m[2] as string);
      if (day === null || time === null) return "";
      return `${time}:${day}`;
    },
  },
  // "every day at <time>"
  {
    pattern: /every\s+day\s+at\s+(\S+)/i,
    extract: (m) => {
      const time = parseTime(m[1] as string);
      return time ?? "";
    },
  },
  // "daily at <time>"
  {
    pattern: /daily\s+at\s+(\S+)/i,
    extract: (m) => {
      const time = parseTime(m[1] as string);
      return time ?? "";
    },
  },
  // "every <N> minutes"
  {
    pattern: /every\s+(\d+)\s+minutes?/i,
    extract: (m) => {
      const mins = Number.parseInt(m[1] as string, 10);
      return mins > 0 ? `*/${mins}` : "";
    },
  },
  // "every <N> hours"
  {
    pattern: /every\s+(\d+)\s+hours?/i,
    extract: (m) => {
      const hrs = Number.parseInt(m[1] as string, 10);
      return hrs > 0 ? `*/${hrs * 60}` : "";
    },
  },
  // "every morning" -> 08:00 daily
  {
    pattern: /every\s+morning/i,
    extract: () => "08:00",
  },
  // "every evening" -> 18:00 daily
  {
    pattern: /every\s+evening/i,
    extract: () => "18:00",
  },
  // "weekdays at <time>"
  {
    // Weekday-only not directly expressible in our simple cron;
    // use Monday as representative (user can adjust)
    pattern: /weekdays?\s+at\s+(\S+)/i,
    extract: (m) => {
      const time = parseTime(m[1] as string);
      if (!time) return "";
      // Create a Monday schedule as approximation
      return `${time}:1`;
    },
  },
];

/**
 * Extract the schedule portion from a natural language input,
 * returning the cron expression and the remaining action text.
 */
function extractScheduleAndAction(input: string): { cron: string; actionText: string } | null {
  const trimmed = input.trim();

  for (const sp of SCHEDULE_PATTERNS) {
    const match = trimmed.match(sp.pattern);
    if (match) {
      const cron = sp.extract(match);
      if (!cron) continue;

      // Remove the schedule portion and common conjunctions to get the action
      const scheduleEnd = (match.index ?? 0) + match[0].length;
      let actionText = trimmed.slice(scheduleEnd).trim();

      // Strip leading comma or conjunctions
      actionText = actionText.replace(/^[,;]\s*/, "");
      actionText = actionText.replace(/^(then|and then|and)\s+/i, "");

      // If action text is empty, use the whole input as the prompt
      if (!actionText) {
        actionText = trimmed;
      }

      return { cron, actionText };
    }
  }

  return null;
}

/**
 * Derive a short human-readable name from the action text.
 * Truncates to 60 characters and capitalizes the first letter.
 */
function deriveName(actionText: string): string {
  const cleaned = actionText.replace(/\s+/g, " ").trim();
  const truncated = cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
  return truncated.charAt(0).toUpperCase() + truncated.slice(1);
}

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

// Export the parsing helpers for testing
export { deriveName, extractScheduleAndAction, parseDay, parseTime };
