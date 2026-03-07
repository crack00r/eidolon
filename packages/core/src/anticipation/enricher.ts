/**
 * ContextEnricher -- gathers supporting data for detected patterns
 * to make proactive notifications actually useful.
 */

import type { MemorySearchResult } from "@eidolon/protocol";
import type { CalendarManager } from "../calendar/manager.ts";
import type { Logger } from "../logging/logger.ts";
import type { MemorySearch } from "../memory/search.ts";
import type { DetectedPattern } from "./patterns.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnrichedContext {
  readonly pattern: DetectedPattern;
  readonly relatedMemories: readonly MemorySearchResult[];
  readonly calendarContext: string;
}

// ---------------------------------------------------------------------------
// ContextEnricher
// ---------------------------------------------------------------------------

export class ContextEnricher {
  private readonly memorySearch: MemorySearch;
  private readonly calendarManager: CalendarManager | null;
  private readonly logger: Logger;

  constructor(
    memorySearch: MemorySearch,
    calendarManager: CalendarManager | null,
    logger: Logger,
  ) {
    this.memorySearch = memorySearch;
    this.calendarManager = calendarManager;
    this.logger = logger;
  }

  /** Enrich a detected pattern with related memories and calendar context. */
  async enrich(pattern: DetectedPattern): Promise<EnrichedContext> {
    const relatedMemories = await this.queryMemories(pattern);
    const calendarContext = this.getCalendarContext(pattern);

    return {
      pattern,
      relatedMemories,
      calendarContext,
    };
  }

  /** Enrich multiple patterns. */
  async enrichAll(patterns: readonly DetectedPattern[]): Promise<EnrichedContext[]> {
    const results: EnrichedContext[] = [];
    for (const pattern of patterns) {
      try {
        const enriched = await this.enrich(pattern);
        results.push(enriched);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn("anticipation-enricher", `Failed to enrich pattern ${pattern.type}: ${msg}`);
        // Still include with empty context so the notification can be sent
        results.push({
          pattern,
          relatedMemories: [],
          calendarContext: "",
        });
      }
    }
    return results;
  }

  private async queryMemories(pattern: DetectedPattern): Promise<MemorySearchResult[]> {
    const queryText = this.buildSearchQuery(pattern);
    if (!queryText) return [];

    const searchResult = await this.memorySearch.search({
      text: queryText,
      limit: 5,
      types: this.getMemoryTypesForPattern(pattern),
    });

    if (!searchResult.ok) {
      this.logger.warn("anticipation-enricher", `Memory search failed: ${searchResult.error.message}`);
      return [];
    }

    return searchResult.value;
  }

  private buildSearchQuery(pattern: DetectedPattern): string {
    switch (pattern.type) {
      case "meeting_prep":
        return pattern.relevantEntities.join(" ");
      case "travel_prep": {
        const dest = typeof pattern.metadata.destination === "string"
          ? pattern.metadata.destination
          : "";
        return dest || (pattern.relevantEntities[0] ?? "");
      }
      case "follow_up":
        return typeof pattern.metadata.commitment === "string"
          ? pattern.metadata.commitment
          : "";
      case "birthday_reminder":
        return pattern.relevantEntities[0] ?? "";
      case "health_nudge":
        return "training exercise workout";
      default:
        return "";
    }
  }

  private getMemoryTypesForPattern(
    pattern: DetectedPattern,
  ): ("episode" | "preference" | "decision" | "fact" | "skill" | "relationship" | "schema")[] {
    switch (pattern.type) {
      case "meeting_prep":
        return ["episode"];
      case "health_nudge":
        return ["preference"];
      case "follow_up":
        return ["decision", "episode"];
      case "birthday_reminder":
        return ["episode", "relationship"];
      default:
        return ["episode"];
    }
  }

  private getCalendarContext(pattern: DetectedPattern): string {
    if (!this.calendarManager) return "";

    // For calendar-related patterns, include schedule context
    if (pattern.type === "meeting_prep" || pattern.type === "travel_prep") {
      const result = this.calendarManager.injectScheduleContext();
      if (result.ok) return result.value;
    }

    return "";
  }
}
