/**
 * Priority evaluator for scoring bus events.
 *
 * Assigns a numeric score (0-100), suggested action type,
 * and model complexity for each event based on its type.
 */

import type { BusEvent } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { ActionType } from "./state-machine.ts";

export interface PriorityScore {
  readonly score: number;
  readonly reason: string;
  readonly suggestedAction: ActionType;
  readonly suggestedModel: "fast" | "default" | "complex";
}

interface ScoringRule {
  readonly score: number;
  readonly reason: string;
  readonly action: ActionType;
  readonly model: "fast" | "default" | "complex";
}

const EVENT_SCORING: ReadonlyMap<string, ScoringRule> = new Map([
  [
    "user:message",
    { score: 95, reason: "User message requires immediate response", action: "respond", model: "default" },
  ],
  ["user:voice", { score: 90, reason: "Voice input requires prompt response", action: "respond", model: "default" }],
  [
    "user:approval",
    { score: 85, reason: "User approval unblocks pending work", action: "execute_task", model: "fast" },
  ],
  ["system:shutdown", { score: 100, reason: "System shutdown is critical", action: "alert", model: "fast" }],
  ["system:startup", { score: 80, reason: "System startup initialization", action: "alert", model: "fast" }],
  ["system:health_check", { score: 40, reason: "Routine health check", action: "alert", model: "fast" }],
  [
    "system:config_changed",
    { score: 60, reason: "Configuration change needs processing", action: "execute_task", model: "fast" },
  ],
  ["channel:error", { score: 70, reason: "Channel error needs attention", action: "alert", model: "fast" }],
  ["channel:connected", { score: 35, reason: "Channel connected notification", action: "alert", model: "fast" }],
  [
    "channel:disconnected",
    { score: 55, reason: "Channel disconnected needs monitoring", action: "alert", model: "fast" },
  ],
  ["session:failed", { score: 75, reason: "Session failure needs handling", action: "alert", model: "fast" }],
  ["session:started", { score: 30, reason: "Session started notification", action: "execute_task", model: "fast" }],
  ["session:completed", { score: 30, reason: "Session completed notification", action: "execute_task", model: "fast" }],
  ["session:budget_warning", { score: 65, reason: "Budget warning needs attention", action: "alert", model: "fast" }],
  ["scheduler:task_due", { score: 50, reason: "Scheduled task is due", action: "execute_task", model: "default" }],
  ["learning:discovery", { score: 30, reason: "Learning discovery for evaluation", action: "learn", model: "fast" }],
  [
    "learning:approved",
    { score: 45, reason: "Approved learning ready for implementation", action: "learn", model: "default" },
  ],
  ["learning:rejected", { score: 20, reason: "Learning rejected, log only", action: "rest", model: "fast" }],
  ["learning:implemented", { score: 25, reason: "Learning implemented, log only", action: "rest", model: "fast" }],
  ["memory:extracted", { score: 35, reason: "Memory extracted for indexing", action: "execute_task", model: "fast" }],
  ["memory:dream_start", { score: 20, reason: "Dream consolidation starting", action: "dream", model: "default" }],
  ["memory:dream_complete", { score: 25, reason: "Dream consolidation completed", action: "rest", model: "fast" }],
  ["gateway:client_connected", { score: 35, reason: "Gateway client connected", action: "alert", model: "fast" }],
  ["gateway:client_disconnected", { score: 30, reason: "Gateway client disconnected", action: "alert", model: "fast" }],
]);

const DEFAULT_RULE: ScoringRule = {
  score: 25,
  reason: "Unknown event type, low priority",
  action: "rest",
  model: "fast",
};

export class PriorityEvaluator {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /** Score an event for processing priority. */
  evaluate(event: BusEvent): PriorityScore {
    const rule = EVENT_SCORING.get(event.type) ?? DEFAULT_RULE;

    // Boost score for critical/high priority overrides
    let adjustedScore = rule.score;
    if (event.priority === "critical" && adjustedScore < 100) {
      adjustedScore = Math.min(100, adjustedScore + 20);
    } else if (event.priority === "high" && adjustedScore < 90) {
      adjustedScore = Math.min(100, adjustedScore + 10);
    }

    // Upgrade model for complex user messages
    let model = rule.model;
    if (event.type === "user:message" && event.priority === "critical") {
      model = "complex";
    }

    const result: PriorityScore = {
      score: adjustedScore,
      reason: rule.reason,
      suggestedAction: rule.action,
      suggestedModel: model,
    };

    this.logger.debug("priority", `Scored ${event.type}: ${adjustedScore}`, {
      action: result.suggestedAction,
      model: result.suggestedModel,
    });

    return result;
  }
}
