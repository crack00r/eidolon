/**
 * Scheduled task types for cron-based and conditional task execution.
 */

export type ScheduleType = "once" | "recurring" | "conditional";

export interface ScheduledTask {
  readonly id: string;
  readonly name: string;
  readonly type: ScheduleType;
  readonly cron?: string;
  readonly runAt?: number;
  readonly condition?: string;
  readonly action: string;
  readonly payload: Record<string, unknown>;
  readonly enabled: boolean;
  readonly lastRunAt?: number;
  readonly nextRunAt?: number;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Automation types (Khoj-style scheduled automations)
// ---------------------------------------------------------------------------

/**
 * An automation task is a scheduled task with a Claude Code prompt that runs
 * on a schedule and delivers results to a specific channel.
 *
 * Created via natural language: "Every Monday at 9am, research TypeScript news
 * and send me a summary."
 */
export interface AutomationTask {
  /** Unique automation identifier. */
  readonly id: string;
  /** Human-readable name derived from the natural language input. */
  readonly name: string;
  /** The prompt to send to Claude Code when the automation triggers. */
  readonly prompt: string;
  /** Channel to deliver the result to (e.g., "telegram", "desktop", "cli"). */
  readonly deliverTo: string;
  /** Cron expression for the schedule. */
  readonly cron: string;
  /** Original natural language input from the user. */
  readonly originalInput: string;
  /** Whether the automation is active. */
  readonly enabled: boolean;
  /** Timestamp of last execution (ms since epoch). */
  readonly lastRunAt?: number;
  /** Timestamp of next scheduled execution (ms since epoch). */
  readonly nextRunAt?: number;
  /** Timestamp of creation (ms since epoch). */
  readonly createdAt: number;
}

/**
 * Parsed result from natural language automation input.
 * Produced by AutomationEngine.parseNaturalLanguage().
 */
export interface ParsedAutomation {
  /** Human-readable name for the automation. */
  readonly name: string;
  /** Cron expression extracted from the natural language schedule. */
  readonly cron: string;
  /** The prompt to execute when the automation triggers. */
  readonly prompt: string;
  /** Channel to deliver results to. */
  readonly deliverTo: string;
}
