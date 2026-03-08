/**
 * DreamScheduler -- determines when to trigger dreaming cycles.
 *
 * Supports both scheduled (time-of-day) and idle-triggered dreaming.
 * The schedule is specified as an "HH:MM" time string in the configured timezone.
 */

import type { Logger } from "../../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DreamScheduleConfig {
  readonly enabled: boolean;
  readonly schedule: string;
  readonly maxDurationMs: number;
  readonly triggerOnIdleMs?: number;
  readonly timezone: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default dream window: +/- 30 minutes around the scheduled time. */
const DREAM_WINDOW_MS = 30 * 60 * 1000;

/** Minimum dream duration (1 minute). */
const MIN_DURATION_MS = 60 * 1000;

/** Maximum dream duration (24 hours). */
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/** Minimum idle trigger threshold (1 minute). */
const MIN_IDLE_TRIGGER_MS = 60 * 1000;

/** HH:MM time schedule pattern. */
const SCHEDULE_PATTERN = /^\d{1,2}:\d{2}$/;

// ---------------------------------------------------------------------------
// DreamScheduler
// ---------------------------------------------------------------------------

export class DreamScheduler {
  private readonly config: DreamScheduleConfig;
  private readonly logger: Logger;

  constructor(config: DreamScheduleConfig, logger: Logger) {
    DreamScheduler.validateConfig(config);
    this.config = config;
    this.logger = logger.child("dream-scheduler");
  }

  /** Validate schedule configuration parameters. */
  private static validateConfig(config: DreamScheduleConfig): void {
    // Validate schedule format (HH:MM)
    if (!SCHEDULE_PATTERN.test(config.schedule)) {
      throw new Error(`Invalid dream schedule format "${config.schedule}". Expected HH:MM (e.g., "02:00").`);
    }

    const parts = config.schedule.split(":");
    const hours = parseInt(parts[0] ?? "0", 10);
    const minutes = parseInt(parts[1] ?? "0", 10);
    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
      throw new Error(`Invalid dream schedule time "${config.schedule}". Hours must be 0-23, minutes 0-59.`);
    }

    // Validate maxDurationMs bounds
    if (config.maxDurationMs < MIN_DURATION_MS || config.maxDurationMs > MAX_DURATION_MS) {
      throw new Error(
        `maxDurationMs must be between ${MIN_DURATION_MS}ms (1 min) and ${MAX_DURATION_MS}ms (24 h), got ${config.maxDurationMs}.`,
      );
    }

    // Validate idle trigger threshold if provided
    if (config.triggerOnIdleMs !== undefined && config.triggerOnIdleMs < MIN_IDLE_TRIGGER_MS) {
      throw new Error(
        `triggerOnIdleMs must be at least ${MIN_IDLE_TRIGGER_MS}ms (1 min), got ${config.triggerOnIdleMs}.`,
      );
    }
  }

  /**
   * Check if it's time to dream based on schedule + idle.
   * Returns true if:
   *  - dreaming is enabled AND
   *  - either we are in the dream window (scheduled time) OR idle threshold has been exceeded
   *  - AND enough time has passed since the last dream (at least maxDurationMs)
   */
  shouldDream(lastActivityAt: number, lastDreamAt: number): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const now = Date.now();

    // Don't dream if last dream was too recent (still within cooldown)
    if (now - lastDreamAt < this.config.maxDurationMs) {
      return false;
    }

    // Check idle trigger
    if (this.config.triggerOnIdleMs !== undefined) {
      const idleMs = now - lastActivityAt;
      if (idleMs >= this.config.triggerOnIdleMs) {
        this.logger.debug("shouldDream", "Idle trigger met", { idleMs, threshold: this.config.triggerOnIdleMs });
        return true;
      }
    }

    // Check schedule-based trigger
    if (this.isInDreamWindow()) {
      this.logger.debug("shouldDream", "In dream window");
      return true;
    }

    return false;
  }

  /** Get ms until next scheduled dream time. */
  msUntilNextDream(): number {
    const now = new Date();
    const { hours, minutes } = this.parseSchedule();

    // Get current hour/minute in the configured timezone using Intl.DateTimeFormat
    // (avoids the anti-pattern of parsing toLocaleString which can produce wrong results
    //  due to DST transitions and locale-dependent formatting)
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const tzHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const tzMinute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

    const nowMinutes = tzHour * 60 + tzMinute;
    const targetMinutes = hours * 60 + minutes;
    let diffMs = (targetMinutes - nowMinutes) * 60 * 1000;
    if (diffMs <= 0) {
      // Already past today's schedule, next is tomorrow
      diffMs += 24 * 60 * 60 * 1000;
    }

    return diffMs;
  }

  /** Check if we're within the dream time window (+/- 30 min of schedule). */
  isInDreamWindow(): boolean {
    const { hours, minutes } = this.parseSchedule();
    const now = new Date();

    // Get current hour/minute in the configured timezone using Intl.DateTimeFormat
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: this.config.timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(now);
    const tzHour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
    const tzMinute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);

    const nowMinutes = tzHour * 60 + tzMinute;
    const targetMinutes = hours * 60 + minutes;
    // Handle midnight wraparound: e.g., now=23:50 target=00:10 should be 20 min apart
    const totalDayMinutes = 24 * 60;
    const rawDiff = Math.abs(nowMinutes - targetMinutes);
    const wrappedDiff = Math.min(rawDiff, totalDayMinutes - rawDiff);
    const diffMs = wrappedDiff * 60 * 1000;
    return diffMs <= DREAM_WINDOW_MS;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private parseSchedule(): { hours: number; minutes: number } {
    const parts = this.config.schedule.split(":");
    const hours = parseInt(parts[0] ?? "2", 10);
    const minutes = parseInt(parts[1] ?? "0", 10);
    return { hours, minutes };
  }
}
