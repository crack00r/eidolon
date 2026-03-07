/**
 * AnticipationEngine -- orchestrates the proactive intelligence pipeline.
 *
 * Pipeline: detect patterns -> evaluate triggers -> enrich context -> compose notifications.
 * Called periodically by the scheduler via the anticipation:check event.
 */

import { randomUUID } from "node:crypto";
import type { AnticipationConfig, AnticipationSuggestionPayload } from "@eidolon/protocol";
import type { CalendarManager } from "../calendar/manager.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { KGEntityStore } from "../memory/knowledge-graph/entities.ts";
import type { KGRelationStore } from "../memory/knowledge-graph/relations.ts";
import type { UserProfileGenerator } from "../memory/profile.ts";
import type { MemorySearch } from "../memory/search.ts";
import type { ComposedSuggestion } from "./composer.ts";
import { ActionComposer } from "./composer.ts";
import {
  BirthdayDetector,
  FollowUpDetector,
  HealthNudgeDetector,
  MeetingPrepDetector,
  TravelPrepDetector,
} from "./detectors/index.ts";
import { ContextEnricher } from "./enricher.ts";
import type { SuggestionHistory } from "./history.ts";
import type { DetectedPattern, DetectionContext, IPatternDetector } from "./patterns.ts";
import { buildEntityKey, TriggerEvaluator } from "./trigger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnticipationEngineDeps {
  readonly memorySearch: MemorySearch;
  readonly calendarManager: CalendarManager | null;
  readonly profileGenerator: UserProfileGenerator;
  readonly kgEntityStore: KGEntityStore | null;
  readonly kgRelationStore: KGRelationStore | null;
  readonly history: SuggestionHistory;
  readonly eventBus: EventBus;
  readonly config: AnticipationConfig;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// AnticipationEngine
// ---------------------------------------------------------------------------

export class AnticipationEngine {
  private readonly detectors: IPatternDetector[];
  private readonly enricher: ContextEnricher;
  private readonly trigger: TriggerEvaluator;
  private readonly composer: ActionComposer;
  private readonly history: SuggestionHistory;
  private readonly eventBus: EventBus;
  private readonly calendarManager: CalendarManager | null;
  private readonly profileGenerator: UserProfileGenerator;
  private readonly memorySearch: MemorySearch;
  private readonly config: AnticipationConfig;
  private readonly logger: Logger;

  constructor(deps: AnticipationEngineDeps) {
    this.memorySearch = deps.memorySearch;
    this.calendarManager = deps.calendarManager;
    this.profileGenerator = deps.profileGenerator;
    this.history = deps.history;
    this.eventBus = deps.eventBus;
    this.config = deps.config;
    this.logger = deps.logger;

    // Initialize sub-components
    this.enricher = new ContextEnricher(deps.memorySearch, deps.calendarManager, deps.logger);
    this.trigger = new TriggerEvaluator(deps.history, deps.config, deps.logger);
    this.composer = new ActionComposer(deps.config, deps.logger);

    // Build detector list from config
    this.detectors = this.buildDetectors(deps);
  }

  /** Register an additional detector (for plugins). */
  registerDetector(detector: IPatternDetector): void {
    this.detectors.push(detector);
    this.logger.info("anticipation", `Registered custom detector: ${detector.name} (${detector.id})`);
  }

  /** Run the full anticipation pipeline. Returns composed suggestions. */
  async check(): Promise<ComposedSuggestion[]> {
    if (!this.config.enabled) {
      this.logger.debug("anticipation", "Anticipation engine disabled");
      return [];
    }

    try {
      // 1. Build detection context
      const context = await this.buildContext();

      // 2. Run all detectors
      const allPatterns = await this.runDetectors(context);
      if (allPatterns.length === 0) {
        this.logger.debug("anticipation", "No patterns detected");
        return [];
      }

      this.logger.info("anticipation", `Detected ${allPatterns.length} pattern(s)`);

      // 3. Evaluate triggers (filter)
      const triggered = this.trigger.evaluate(allPatterns);
      if (triggered.length === 0) {
        this.logger.debug("anticipation", "All patterns filtered by trigger evaluator");
        return [];
      }

      this.logger.info("anticipation", `${triggered.length} pattern(s) passed trigger evaluation`);

      // 4. Enrich context
      const enriched = await this.enricher.enrichAll(triggered);

      // 5. Compose notifications
      const suggestions = await this.composer.composeAll(enriched);

      // 6. Record and publish
      for (let i = 0; i < suggestions.length; i++) {
        const suggestion = suggestions[i];
        if (!suggestion) continue;
        const pattern = triggered[i];
        if (!pattern) continue;

        const entityKey = buildEntityKey(pattern);

        // Record in history
        this.history.record({
          patternType: suggestion.patternType,
          detectorId: pattern.detectorId,
          entityKey,
          confidence: pattern.confidence,
          suggestionTitle: suggestion.title,
          channelId: suggestion.channelId,
        });

        // Publish event
        const payload: AnticipationSuggestionPayload = {
          suggestionId: randomUUID(),
          patternType: suggestion.patternType,
          title: suggestion.title,
          body: suggestion.body,
          channelId: suggestion.channelId,
          priority: suggestion.priority,
          actionable: suggestion.actionable,
          suggestedAction: suggestion.suggestedAction,
          calendarEventId: pattern.calendarEventId,
          entityKey: entityKey ?? "",
          confidence: pattern.confidence,
        };

        this.eventBus.publish("anticipation:suggestion", payload, {
          priority: suggestion.priority === "critical" ? "high" : "normal",
          source: "anticipation",
        });
      }

      this.logger.info("anticipation", `Published ${suggestions.length} suggestion(s)`);
      return suggestions;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error("anticipation", `Anticipation check failed: ${msg}`);
      return [];
    }
  }

  private async buildContext(): Promise<DetectionContext> {
    const now = Date.now();

    // Get user profile
    const profile = this.profileGenerator.generateProfile();
    const timezone = profile.timezone ?? "Europe/Berlin";

    // Get upcoming events (48h window)
    let upcomingEvents: DetectionContext["upcomingEvents"] = [];
    if (this.calendarManager) {
      const eventsResult = this.calendarManager.getUpcoming(48);
      if (eventsResult.ok) {
        upcomingEvents = eventsResult.value;
      }
    }

    // Get recent memories (7-day window)
    const recentResult = await this.memorySearch.search({
      text: "*",
      limit: 50,
    });
    const recentMemories = recentResult.ok
      ? recentResult.value.map((r) => r.memory)
      : [];

    return { now, profile, upcomingEvents, recentMemories, timezone };
  }

  private async runDetectors(context: DetectionContext): Promise<DetectedPattern[]> {
    const allPatterns: DetectedPattern[] = [];

    for (const detector of this.detectors) {
      try {
        const patterns = await detector.detect(context);
        allPatterns.push(...patterns);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn("anticipation", `Detector ${detector.id} failed: ${msg}`);
      }
    }

    return allPatterns;
  }

  private buildDetectors(deps: AnticipationEngineDeps): IPatternDetector[] {
    const detectors: IPatternDetector[] = [];
    const dc = deps.config.detectors;

    if (dc.meetingPrep.enabled) {
      detectors.push(new MeetingPrepDetector(deps.memorySearch, deps.kgEntityStore, dc.meetingPrep));
    }
    if (dc.travelPrep.enabled) {
      detectors.push(new TravelPrepDetector(dc.travelPrep));
    }
    if (dc.healthNudge.enabled) {
      detectors.push(new HealthNudgeDetector(dc.healthNudge));
    }
    if (dc.followUp.enabled) {
      detectors.push(new FollowUpDetector(dc.followUp));
    }
    if (dc.birthday.enabled) {
      detectors.push(new BirthdayDetector(deps.kgEntityStore, deps.kgRelationStore, dc.birthday));
    }

    return detectors;
  }
}
