/**
 * Adaptive rest duration calculator.
 *
 * Determines how long the cognitive loop should sleep between cycles
 * based on recent user activity, pending work, and time of day.
 *
 * Uses timezone-aware business hours from config to determine whether
 * it's currently within business hours or night mode.
 */

import type { Logger } from "../logging/logger.ts";

export interface RestConfig {
  readonly activeMinMs: number;
  readonly idleMinMs: number;
  readonly maxMs: number;
  readonly nightModeStartHour: number;
  readonly nightModeEndHour: number;
  readonly nightModeMultiplier: number;
}

export interface BusinessHoursConfig {
  /** Start time in HH:MM 24h format (e.g. "07:00"). */
  readonly start: string;
  /** End time in HH:MM 24h format (e.g. "23:00"). */
  readonly end: string;
  /** IANA timezone (e.g. "Europe/Berlin"). */
  readonly timezone: string;
}

export const DEFAULT_REST_CONFIG: RestConfig = {
  activeMinMs: 2_000,
  idleMinMs: 30_000,
  maxMs: 300_000,
  nightModeStartHour: 23,
  nightModeEndHour: 7,
  nightModeMultiplier: 3,
};

export const DEFAULT_BUSINESS_HOURS: BusinessHoursConfig = {
  start: "07:00",
  end: "23:00",
  timezone: "Europe/Berlin",
};

export interface RestContext {
  readonly lastUserActivityAt: number;
  readonly hasPendingEvents: boolean;
  readonly hasPendingLearning: boolean;
  /**
   * If true, overrides business hours detection.
   * If false, overrides business hours detection.
   * If undefined, the calculator determines business hours from config + timezone.
   */
  readonly isBusinessHours?: boolean;
}

const TEN_SECONDS = 10_000;
const ONE_MINUTE = 60_000;
const FIVE_MINUTES = 300_000;

/** Rest duration when user was active within the last minute. */
const RECENT_ACTIVITY_REST_MS = 5_000;
/** Rest duration when user was active within the last 5 minutes. */
const MODERATE_IDLE_REST_MS = 15_000;
/** Rest duration when off-hours with pending learning tasks. */
const PENDING_LEARNING_REST_MS = 60_000;

/**
 * Parse an HH:MM string into minutes since midnight.
 * Returns null on invalid input.
 */
function parseHHMM(value: string): number | null {
  const parts = value.split(":");
  if (parts.length !== 2) return null;
  const h = Number(parts[0]);
  const m = Number(parts[1]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

/**
 * Get the current hour and minute as minutes-since-midnight in a specific timezone.
 * Falls back to local system time if the timezone is invalid.
 */
function getMinutesInTimezone(date: Date, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    let hour = 0;
    let minute = 0;
    for (const part of parts) {
      if (part.type === "hour") hour = Number(part.value);
      if (part.type === "minute") minute = Number(part.value);
    }
    // Intl may format midnight as 24 in some locales
    if (hour === 24) hour = 0;
    return hour * 60 + minute;
  } catch {
    // Invalid timezone: fall back to local time
    return date.getHours() * 60 + date.getMinutes();
  }
}

/**
 * Get the current hour in a specific timezone. Falls back to local time.
 */
function getHourInTimezone(date: Date, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    for (const part of parts) {
      if (part.type === "hour") {
        const h = Number(part.value);
        return h === 24 ? 0 : h;
      }
    }
    return date.getHours();
  } catch {
    return date.getHours();
  }
}

export class RestCalculator {
  private config: RestConfig;
  private businessHours: BusinessHoursConfig;
  private readonly logger: Logger;
  /** Injectable clock for testing. Defaults to Date.now. */
  private readonly nowFn: () => number;

  constructor(
    config: RestConfig,
    logger: Logger,
    businessHours?: BusinessHoursConfig,
    nowFn?: () => number,
  ) {
    this.config = config;
    this.logger = logger;
    this.businessHours = businessHours ?? DEFAULT_BUSINESS_HOURS;
    this.nowFn = nowFn ?? (() => Date.now());
  }

  /** Update the rest configuration (used by hot-reload). */
  updateConfig(config: RestConfig, businessHours?: BusinessHoursConfig): void {
    this.config = config;
    if (businessHours) {
      this.businessHours = businessHours;
    }
    this.logger.info("rest", "Rest configuration updated via hot-reload", {
      activeMinMs: config.activeMinMs,
      idleMinMs: config.idleMinMs,
      maxMs: config.maxMs,
    });
  }

  /**
   * Calculate how long to rest based on current context.
   *
   * Priority order:
   * 1. User active within 10s -> activeMinMs (e.g. 2s)
   * 2. User active within 60s -> 5s
   * 3. User active within 5 minutes -> 15s
   * 4. Pending events -> activeMinMs
   * 5. During business hours -> idleMinMs (e.g. 30s)
   * 6. Pending learning tasks -> 60s
   * 7. Nothing to do -> maxMs (e.g. 300s)
   *
   * Night mode multiplier is applied on top when active.
   */
  calculate(context: RestContext): number {
    const now = this.nowFn();
    const timeSinceUser = now - context.lastUserActivityAt;
    let duration: number;

    if (timeSinceUser < TEN_SECONDS) {
      // User very recently active: minimal rest
      duration = this.config.activeMinMs;
    } else if (timeSinceUser < ONE_MINUTE) {
      // User active within last minute
      duration = RECENT_ACTIVITY_REST_MS;
    } else if (timeSinceUser < FIVE_MINUTES) {
      // User active within last 5 minutes
      duration = MODERATE_IDLE_REST_MS;
    } else if (context.hasPendingEvents) {
      // Pending events to process
      duration = this.config.activeMinMs;
    } else if (this.resolveBusinessHours(context)) {
      // Business hours, moderate rest
      duration = this.config.idleMinMs;
    } else if (context.hasPendingLearning) {
      // Off-hours with pending learning
      duration = PENDING_LEARNING_REST_MS;
    } else {
      // Nothing to do, maximum rest
      duration = this.config.maxMs;
    }

    // Apply night mode multiplier
    if (this.isNightMode()) {
      duration = Math.min(duration * this.config.nightModeMultiplier, this.config.maxMs);
    }

    this.logger.debug("rest", `Rest duration: ${duration}ms`, {
      timeSinceUser,
      hasPendingEvents: context.hasPendingEvents,
      isNightMode: this.isNightMode(),
      isBusinessHours: this.resolveBusinessHours(context),
    });

    return duration;
  }

  /**
   * Determine if it's currently business hours.
   * Uses the timezone from config for timezone-aware comparison.
   * If context.isBusinessHours is explicitly set, uses that override.
   */
  private resolveBusinessHours(context: RestContext): boolean {
    // Allow explicit override (for testing or external state)
    if (context.isBusinessHours !== undefined) {
      return context.isBusinessHours;
    }
    return this.checkBusinessHours();
  }

  /**
   * Check business hours against the configured timezone.
   */
  checkBusinessHours(): boolean {
    const now = new Date(this.nowFn());
    const currentMinutes = getMinutesInTimezone(now, this.businessHours.timezone);

    const startMinutes = parseHHMM(this.businessHours.start);
    const endMinutes = parseHHMM(this.businessHours.end);

    if (startMinutes === null || endMinutes === null) {
      // Invalid config, assume business hours (safer default)
      return true;
    }

    if (startMinutes <= endMinutes) {
      // Same-day window: e.g. 07:00-23:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    // Cross-midnight window (unusual but supported)
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  /**
   * Check if it's currently night mode.
   * Uses the configured timezone for timezone-aware comparison.
   */
  isNightMode(): boolean {
    const now = new Date(this.nowFn());
    const hour = getHourInTimezone(now, this.businessHours.timezone);
    const { nightModeStartHour, nightModeEndHour } = this.config;

    // Handle wrap-around (e.g., 23-7 spans midnight)
    if (nightModeStartHour > nightModeEndHour) {
      return hour >= nightModeStartHour || hour < nightModeEndHour;
    }
    return hour >= nightModeStartHour && hour < nightModeEndHour;
  }
}
