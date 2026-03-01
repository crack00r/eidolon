/**
 * DreamScheduler -- determines when to trigger dreaming cycles.
 *
 * Supports both scheduled (time-of-day) and idle-triggered dreaming.
 * The schedule is specified as an "HH:MM" time string in the configured timezone.
 */

import type { Logger } from "../../logging/logger.js";

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

// ---------------------------------------------------------------------------
// DreamScheduler
// ---------------------------------------------------------------------------

export class DreamScheduler {
  private readonly config: DreamScheduleConfig;
  private readonly logger: Logger;

  constructor(config: DreamScheduleConfig, logger: Logger) {
    this.config = config;
    this.logger = logger.child("dream-scheduler");
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

    // Get current time in the configured timezone
    const nowInTz = new Date(now.toLocaleString("en-US", { timeZone: this.config.timezone }));
    const targetToday = new Date(nowInTz);
    targetToday.setHours(hours, minutes, 0, 0);

    let diffMs = targetToday.getTime() - nowInTz.getTime();
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

    // Get current time in the configured timezone
    const nowInTz = new Date(now.toLocaleString("en-US", { timeZone: this.config.timezone }));
    const targetToday = new Date(nowInTz);
    targetToday.setHours(hours, minutes, 0, 0);

    const diffMs = Math.abs(nowInTz.getTime() - targetToday.getTime());
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
