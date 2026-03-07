/**
 * TriggerEvaluator -- filters detected patterns to decide which ones
 * should actually fire as notifications. Applies confidence threshold,
 * cooldown, rate limiting, and suppression checks.
 */

import type { AnticipationConfig } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { SuggestionHistory } from "./history.ts";
import type { DetectedPattern } from "./patterns.ts";

// ---------------------------------------------------------------------------
// TriggerEvaluator
// ---------------------------------------------------------------------------

export class TriggerEvaluator {
  private readonly history: SuggestionHistory;
  private readonly config: AnticipationConfig;
  private readonly logger: Logger;

  constructor(
    history: SuggestionHistory,
    config: AnticipationConfig,
    logger: Logger,
  ) {
    this.history = history;
    this.config = config;
    this.logger = logger;
  }

  /** Filter patterns to only those that should fire. */
  evaluate(patterns: readonly DetectedPattern[]): DetectedPattern[] {
    const now = Date.now();
    const passed: DetectedPattern[] = [];

    // Check rate limit first
    const firedCount = this.history.countLastHour();
    const remainingBudget = this.config.maxSuggestionsPerHour - firedCount;

    if (remainingBudget <= 0) {
      this.logger.debug("anticipation-trigger", "Rate limit reached, deferring all patterns");
      return [];
    }

    // Get suppression list
    const suppressions = this.history.getSuppressions(now);
    const suppressedTypes = new Set(suppressions.map((s) => s.patternType));

    for (const pattern of patterns) {
      // 1. Suppression check
      if (suppressedTypes.has(pattern.type)) {
        this.logger.debug("anticipation-trigger", `Pattern ${pattern.type} is suppressed`);
        continue;
      }

      // Also check DB-level suppression (in case in-memory set is stale)
      if (this.history.isSuppressed(pattern.type, now)) {
        this.logger.debug("anticipation-trigger", `Pattern ${pattern.type} is suppressed (DB)`);
        continue;
      }

      // 2. Confidence threshold
      let adjustedConfidence = pattern.confidence;

      // Apply learned confidence reduction from feedback
      const feedbackPenalty = this.calculateFeedbackPenalty(pattern);
      adjustedConfidence -= feedbackPenalty;

      if (adjustedConfidence < this.config.minConfidence) {
        this.logger.debug(
          "anticipation-trigger",
          `Pattern ${pattern.type} below confidence threshold (${adjustedConfidence.toFixed(2)} < ${this.config.minConfidence})`,
        );
        continue;
      }

      // 3. Cooldown check
      const entityKey = buildEntityKey(pattern);
      if (this.history.checkCooldown(pattern.type, entityKey, this.config.cooldownMinutes)) {
        this.logger.debug(
          "anticipation-trigger",
          `Pattern ${pattern.type} on cooldown (entity: ${entityKey ?? "global"})`,
        );
        continue;
      }

      // 4. Rate limit budget
      if (passed.length >= remainingBudget) {
        this.logger.debug("anticipation-trigger", "Rate limit budget exhausted for this batch");
        break;
      }

      passed.push(pattern);
    }

    return passed;
  }

  /** Calculate confidence penalty from repeated dismissals. */
  private calculateFeedbackPenalty(pattern: DetectedPattern): number {
    const recentHistory = this.history.getRecent(Date.now() - 30 * 86_400_000);
    const dismissals = recentHistory.filter(
      (r) => r.patternType === pattern.type && r.feedback === "irrelevant",
    );

    // Each dismissal reduces confidence by 0.1, max 0.3
    return Math.min(dismissals.length * 0.1, 0.3);
  }
}

/** Build a deduplication entity key for cooldown tracking. */
export function buildEntityKey(pattern: DetectedPattern): string | null {
  switch (pattern.type) {
    case "meeting_prep":
      return pattern.calendarEventId ? `meeting:${pattern.calendarEventId}` : null;
    case "travel_prep":
      return pattern.calendarEventId ? `travel:${pattern.calendarEventId}` : null;
    case "health_nudge": {
      const date = typeof pattern.metadata.date === "string"
        ? pattern.metadata.date
        : new Date().toISOString().slice(0, 10);
      return `health:${date}`;
    }
    case "follow_up":
      return typeof pattern.metadata.memoryId === "string"
        ? `followup:${pattern.metadata.memoryId}`
        : null;
    case "birthday_reminder":
      return pattern.relevantEntities[0]
        ? `birthday:${pattern.relevantEntities[0]}`
        : null;
    default:
      return null;
  }
}
