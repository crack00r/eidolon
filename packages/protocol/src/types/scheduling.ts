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
