/**
 * Token allocation and budget tracking.
 *
 * Manages hourly token budgets across categories (user, tasks, learning, dreaming).
 * The user category always overrides budget limits to ensure responsiveness.
 */

import type { Logger } from "../logging/logger.js";

export interface EnergyBudgetConfig {
  readonly maxTokensPerHour: number;
  readonly categories: {
    readonly user: number;
    readonly tasks: number;
    readonly learning: number;
    readonly dreaming: number;
    readonly alert?: number;
  };
}

export type BudgetCategory = "user" | "tasks" | "learning" | "dreaming" | "alert";

const DEFAULT_ESTIMATE = 1000;

/** Soft cap multiplier for user category warning. */
const USER_SOFT_CAP_MULTIPLIER = 5;

interface HourlyUsage {
  hourBucket: number;
  used: Record<BudgetCategory, number>;
}

/** Get the hour bucket for a timestamp (hours since epoch). */
function getHourBucket(timestamp: number): number {
  return Math.floor(timestamp / 3_600_000);
}

export class EnergyBudget {
  private readonly config: EnergyBudgetConfig;
  private readonly logger: Logger;
  private usage: HourlyUsage;

  constructor(config: EnergyBudgetConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.usage = {
      hourBucket: getHourBucket(Date.now()),
      used: { user: 0, tasks: 0, learning: 0, dreaming: 0, alert: 0 },
    };
  }

  /** Check if we can afford to spend tokens on a category. */
  canAfford(category: BudgetCategory, estimatedTokens?: number): boolean {
    this.resetIfNewHour();

    // User category always allowed
    if (category === "user") {
      return true;
    }

    const estimate = estimatedTokens ?? DEFAULT_ESTIMATE;
    return this.remaining(category) >= estimate;
  }

  /** Consume tokens from a category budget. */
  consume(category: BudgetCategory, tokens: number): void {
    this.resetIfNewHour();
    // Guard against negative or non-finite token values
    const safeTokens = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
    this.usage.used[category] += safeTokens;

    // Soft cap warning for user category when usage exceeds 5x allocated budget
    if (category === "user") {
      const allocated = Math.floor(this.config.maxTokensPerHour * this.config.categories.user);
      if (allocated > 0 && this.usage.used[category] > allocated * USER_SOFT_CAP_MULTIPLIER) {
        this.logger.warn(
          "energy-budget",
          `User category usage (${this.usage.used[category]}) exceeds ${USER_SOFT_CAP_MULTIPLIER}x allocated budget (${allocated})`,
          {
            used: this.usage.used[category],
            allocated,
            multiplier: USER_SOFT_CAP_MULTIPLIER,
          },
        );
      }
    }

    this.logger.debug("energy-budget", `Consumed ${tokens} tokens for ${category}`, {
      remaining: this.remaining(category),
      totalRemaining: this.totalRemaining(),
    });
  }

  /** Get remaining tokens for a category in the current hour. */
  remaining(category: BudgetCategory): number {
    this.resetIfNewHour();
    const ratio = this.config.categories[category] ?? 0;
    const allocated = Math.floor(this.config.maxTokensPerHour * ratio);
    const used = this.usage.used[category];
    return Math.max(0, allocated - used);
  }

  /** Get total remaining across all categories. */
  totalRemaining(): number {
    this.resetIfNewHour();
    const categories: BudgetCategory[] = ["user", "tasks", "learning", "dreaming", "alert"];
    let total = 0;
    for (const cat of categories) {
      total += this.remaining(cat);
    }
    return total;
  }

  /** Get usage statistics. Only includes alert category if configured. */
  getStats(): { category: BudgetCategory; allocated: number; used: number; remaining: number }[] {
    this.resetIfNewHour();
    const base: BudgetCategory[] = ["user", "tasks", "learning", "dreaming"];
    // Include alert only if configured with a non-zero allocation or if it has usage
    const alertRatio = this.config.categories.alert ?? 0;
    if (alertRatio > 0 || this.usage.used.alert > 0) {
      base.push("alert");
    }
    const categories = base;
    return categories.map((category) => {
      const ratio = this.config.categories[category] ?? 0;
      const allocated = Math.floor(this.config.maxTokensPerHour * ratio);
      const used = this.usage.used[category];
      return {
        category,
        allocated,
        used,
        remaining: Math.max(0, allocated - used),
      };
    });
  }

  /** Reset the hourly budget (called when hour boundary is crossed). */
  resetIfNewHour(): void {
    const currentBucket = getHourBucket(Date.now());
    if (currentBucket !== this.usage.hourBucket) {
      this.logger.info("energy-budget", "Hour boundary crossed, resetting budget", {
        previousHour: this.usage.hourBucket,
        newHour: currentBucket,
      });
      this.usage = {
        hourBucket: currentBucket,
        used: { user: 0, tasks: 0, learning: 0, dreaming: 0, alert: 0 },
      };
    }
  }
}
