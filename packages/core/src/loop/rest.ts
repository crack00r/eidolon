/**
 * Adaptive rest duration calculator.
 *
 * Determines how long the cognitive loop should sleep between cycles
 * based on recent user activity, pending work, and time of day.
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

export const DEFAULT_REST_CONFIG: RestConfig = {
  activeMinMs: 2_000,
  idleMinMs: 30_000,
  maxMs: 300_000,
  nightModeStartHour: 23,
  nightModeEndHour: 7,
  nightModeMultiplier: 3,
};

export interface RestContext {
  readonly lastUserActivityAt: number;
  readonly hasPendingEvents: boolean;
  readonly hasPendingLearning: boolean;
  readonly isBusinessHours: boolean;
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

export class RestCalculator {
  private config: RestConfig;
  private readonly logger: Logger;

  constructor(config: RestConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** Update the rest configuration (used by hot-reload). */
  updateConfig(config: RestConfig): void {
    this.config = config;
    this.logger.info("rest", "Rest configuration updated via hot-reload", {
      activeMinMs: config.activeMinMs,
      idleMinMs: config.idleMinMs,
      maxMs: config.maxMs,
    });
  }

  /** Calculate how long to rest based on current context. */
  calculate(context: RestContext): number {
    const now = Date.now();
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
    } else if (context.isBusinessHours) {
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
    });

    return duration;
  }

  /** Check if it's currently night mode. */
  isNightMode(): boolean {
    const hour = new Date().getHours();
    const { nightModeStartHour, nightModeEndHour } = this.config;

    // Handle wrap-around (e.g., 23-7 spans midnight)
    if (nightModeStartHour > nightModeEndHour) {
      return hour >= nightModeStartHour || hour < nightModeEndHour;
    }
    return hour >= nightModeStartHour && hour < nightModeEndHour;
  }
}
