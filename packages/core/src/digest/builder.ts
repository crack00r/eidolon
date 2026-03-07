/**
 * DigestBuilder -- assembles a daily digest (morning briefing) from various data sources.
 *
 * Queries conversations, learning discoveries, memory stats, scheduled tasks,
 * token usage metrics, and pending action items for the last 24 hours.
 * Produces a formatted markdown string for delivery via MessageRouter.
 */

import type { Database } from "bun:sqlite";
import type { DigestConfig, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import {
  buildActionItems,
  buildConversationSummary,
  buildLearningSummary,
  buildMemoryStats,
  buildMetrics,
  buildSchedule,
} from "./builder-sections.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single section of the digest output. */
export interface DigestSection {
  readonly title: string;
  readonly content: string;
}

/** Full digest output ready for delivery. */
export interface Digest {
  readonly title: string;
  readonly generatedAt: number;
  readonly sections: readonly DigestSection[];
  readonly markdown: string;
}

/** Dependencies injected into DigestBuilder. */
export interface DigestBuilderDeps {
  readonly operationalDb: Database;
  readonly memoryDb: Database;
  readonly logger: Logger;
  readonly config: DigestConfig;
}

/** Injectable clock for testing. */
export interface DigestBuilderOptions {
  readonly nowProvider?: () => number;
}

/** 24 hours in milliseconds. */
const TWENTY_FOUR_HOURS_MS = 86_400_000;

// ---------------------------------------------------------------------------
// DigestBuilder
// ---------------------------------------------------------------------------

export class DigestBuilder {
  private readonly operationalDb: Database;
  private readonly memoryDb: Database;
  private readonly logger: Logger;
  private readonly config: DigestConfig;
  private readonly nowProvider: () => number;

  constructor(deps: DigestBuilderDeps, options?: DigestBuilderOptions) {
    this.operationalDb = deps.operationalDb;
    this.memoryDb = deps.memoryDb;
    this.logger = deps.logger.child("digest");
    this.config = deps.config;
    this.nowProvider = options?.nowProvider ?? (() => Date.now());
  }

  /** Build the complete digest. Only includes sections enabled in config. */
  build(): Result<Digest, EidolonError> {
    try {
      const now = this.nowProvider();
      const since = now - TWENTY_FOUR_HOURS_MS;
      const sections: DigestSection[] = [];

      if (this.config.sections.conversations) {
        const section = this.buildConversationSummary(since);
        if (section) sections.push(section);
      }

      if (this.config.sections.learning) {
        const section = this.buildLearningSummary(since);
        if (section) sections.push(section);
      }

      if (this.config.sections.memory) {
        const section = this.buildMemoryStats(since);
        if (section) sections.push(section);
      }

      if (this.config.sections.schedule) {
        const section = this.buildSchedule(now);
        if (section) sections.push(section);
      }

      if (this.config.sections.metrics) {
        const section = this.buildMetrics(since);
        if (section) sections.push(section);
      }

      if (this.config.sections.actionItems) {
        const section = this.buildActionItems();
        if (section) sections.push(section);
      }

      const dateStr = this.formatDate(now);
      const title = `Daily Digest -- ${dateStr}`;

      const markdownParts = [`# ${title}`, ""];
      for (const section of sections) {
        markdownParts.push(`## ${section.title}`, "", section.content, "");
      }

      if (sections.length === 0) {
        markdownParts.push("Nothing notable happened in the last 24 hours. All quiet.");
      }

      const markdown = markdownParts.join("\n");

      this.logger.info("build", `Digest built with ${sections.length} section(s)`, {
        sections: sections.map((s) => s.title),
      });

      return Ok({
        title,
        generatedAt: now,
        sections,
        markdown,
      });
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to build digest", cause));
    }
  }

  // -------------------------------------------------------------------------
  // Section Builders (delegated to builder-sections.ts)
  // -------------------------------------------------------------------------

  private buildConversationSummary(since: number): DigestSection | null {
    return buildConversationSummary(this.operationalDb, since);
  }

  private buildLearningSummary(since: number): DigestSection | null {
    return buildLearningSummary(this.operationalDb, since);
  }

  private buildMemoryStats(since: number): DigestSection | null {
    return buildMemoryStats(this.memoryDb, since);
  }

  private buildSchedule(now: number): DigestSection | null {
    return buildSchedule(this.operationalDb, now, (ts) => this.formatTime(ts));
  }

  private buildMetrics(since: number): DigestSection | null {
    return buildMetrics(this.operationalDb, since);
  }

  private buildActionItems(): DigestSection | null {
    return buildActionItems(this.operationalDb);
  }

  // -------------------------------------------------------------------------
  // Formatting Helpers
  // -------------------------------------------------------------------------

  /** Format a timestamp as "YYYY-MM-DD" in the configured timezone. */
  private formatDate(timestamp: number): string {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: this.config.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      return formatter.format(new Date(timestamp));
    } catch {
      // Fallback for invalid timezone
      return new Date(timestamp).toISOString().split("T")[0] ?? "unknown";
    }
  }

  /** Format a timestamp as "HH:MM" in the configured timezone. */
  private formatTime(timestamp: number): string {
    try {
      const formatter = new Intl.DateTimeFormat("en-GB", {
        timeZone: this.config.timezone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      return formatter.format(new Date(timestamp));
    } catch {
      // Intentional: timezone-aware formatting failure falls back to local time
      const d = new Date(timestamp);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
  }
}
