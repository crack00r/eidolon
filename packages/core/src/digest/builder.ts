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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
  // Section Builders
  // -------------------------------------------------------------------------

  /** Summarize conversations (sessions) from the last 24h. */
  private buildConversationSummary(since: number): DigestSection | null {
    const rows = this.operationalDb
      .query(
        `SELECT type, status, tokens_used, cost_usd, started_at, completed_at
         FROM sessions
         WHERE started_at >= ?
         ORDER BY started_at DESC`,
      )
      .all(since) as ReadonlyArray<{
      type: string;
      status: string;
      tokens_used: number;
      cost_usd: number;
      started_at: number;
      completed_at: number | null;
    }>;

    if (rows.length === 0) return null;

    const totalTokens = rows.reduce((sum, r) => sum + r.tokens_used, 0);
    const totalCost = rows.reduce((sum, r) => sum + r.cost_usd, 0);

    const byType: Record<string, number> = {};
    for (const row of rows) {
      byType[row.type] = (byType[row.type] ?? 0) + 1;
    }

    const lines: string[] = [];
    lines.push(`- **${rows.length}** session(s) in the last 24 hours`);

    const typeEntries = Object.entries(byType);
    if (typeEntries.length > 0) {
      const parts = typeEntries.map(([type, count]) => `${type}: ${count}`);
      lines.push(`- By type: ${parts.join(", ")}`);
    }

    if (totalTokens > 0) {
      lines.push(`- Tokens used: ${totalTokens.toLocaleString()}`);
    }
    if (totalCost > 0) {
      lines.push(`- Cost: $${totalCost.toFixed(4)}`);
    }

    return { title: "Conversations", content: lines.join("\n") };
  }

  /** Summarize learning discoveries from the last 24h. */
  private buildLearningSummary(since: number): DigestSection | null {
    const rows = this.operationalDb
      .query(
        `SELECT title, source_type, relevance_score, status, safety_level
         FROM discoveries
         WHERE created_at >= ?
         ORDER BY relevance_score DESC`,
      )
      .all(since) as ReadonlyArray<{
      title: string;
      source_type: string;
      relevance_score: number;
      status: string;
      safety_level: string;
    }>;

    if (rows.length === 0) return null;

    const lines: string[] = [];
    lines.push(`- **${rows.length}** discovery(ies) in the last 24 hours`);

    const byStatus: Record<string, number> = {};
    for (const row of rows) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    }

    const statusParts = Object.entries(byStatus).map(([status, count]) => `${status}: ${count}`);
    if (statusParts.length > 0) {
      lines.push(`- By status: ${statusParts.join(", ")}`);
    }

    // Show top 5 discoveries by relevance
    const top = rows.slice(0, 5);
    if (top.length > 0) {
      lines.push("");
      lines.push("**Top discoveries:**");
      for (const d of top) {
        const score = Math.round(d.relevance_score * 100);
        lines.push(`- [${d.source_type}] ${d.title} (relevance: ${score}%, status: ${d.status})`);
      }
    }

    return { title: "Learning", content: lines.join("\n") };
  }

  /** Memory stats: new memories created in the last 24h. */
  private buildMemoryStats(since: number): DigestSection | null {
    const newCountRow = this.memoryDb
      .query("SELECT COUNT(*) as count FROM memories WHERE created_at >= ?")
      .get(since) as { count: number } | null;

    const totalCountRow = this.memoryDb.query("SELECT COUNT(*) as count FROM memories").get() as {
      count: number;
    } | null;

    const newCount = newCountRow?.count ?? 0;
    const totalCount = totalCountRow?.count ?? 0;

    if (newCount === 0 && totalCount === 0) return null;

    const lines: string[] = [];

    if (newCount > 0) {
      lines.push(`- **${newCount}** new memory(ies) created`);
    } else {
      lines.push("- No new memories created");
    }

    lines.push(`- **${totalCount}** total memories in store`);

    // Count by type for new memories
    if (newCount > 0) {
      const byTypeRows = this.memoryDb
        .query(
          `SELECT type, COUNT(*) as count
           FROM memories WHERE created_at >= ?
           GROUP BY type ORDER BY count DESC`,
        )
        .all(since) as ReadonlyArray<{ type: string; count: number }>;

      if (byTypeRows.length > 0) {
        const parts = byTypeRows.map((r) => `${r.type}: ${r.count}`);
        lines.push(`- New by type: ${parts.join(", ")}`);
      }
    }

    return { title: "Memory", content: lines.join("\n") };
  }

  /** Today's scheduled tasks. */
  private buildSchedule(now: number): DigestSection | null {
    // Get tasks due in the next 24 hours
    const endOfDay = now + TWENTY_FOUR_HOURS_MS;

    const rows = this.operationalDb
      .query(
        `SELECT name, type, cron, next_run_at
         FROM scheduled_tasks
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC`,
      )
      .all(endOfDay) as ReadonlyArray<{
      name: string;
      type: string;
      cron: string | null;
      next_run_at: number;
    }>;

    if (rows.length === 0) return null;

    const lines: string[] = [];
    lines.push(`- **${rows.length}** task(s) scheduled for today`);
    lines.push("");

    for (const task of rows) {
      const timeStr = this.formatTime(task.next_run_at);
      lines.push(`- ${timeStr} -- ${task.name} (${task.type})`);
    }

    return { title: "Schedule", content: lines.join("\n") };
  }

  /** Token usage and cost metrics from the last 24h. */
  private buildMetrics(since: number): DigestSection | null {
    const totals = this.operationalDb
      .query(
        `SELECT
           COALESCE(SUM(input_tokens), 0) as total_input,
           COALESCE(SUM(output_tokens), 0) as total_output,
           COALESCE(SUM(cost_usd), 0) as total_cost
         FROM token_usage
         WHERE timestamp >= ?`,
      )
      .get(since) as {
      total_input: number;
      total_output: number;
      total_cost: number;
    } | null;

    if (!totals || (totals.total_input === 0 && totals.total_output === 0)) return null;

    const lines: string[] = [];
    lines.push(`- Input tokens: ${totals.total_input.toLocaleString()}`);
    lines.push(`- Output tokens: ${totals.total_output.toLocaleString()}`);
    lines.push(`- Total cost: $${totals.total_cost.toFixed(4)}`);

    // Cost by model
    const byModel = this.operationalDb
      .query(
        `SELECT model, SUM(cost_usd) as cost
         FROM token_usage WHERE timestamp >= ?
         GROUP BY model ORDER BY cost DESC`,
      )
      .all(since) as ReadonlyArray<{ model: string; cost: number }>;

    if (byModel.length > 1) {
      lines.push("");
      lines.push("**By model:**");
      for (const row of byModel) {
        lines.push(`- ${row.model}: $${row.cost.toFixed(4)}`);
      }
    }

    return { title: "Metrics", content: lines.join("\n") };
  }

  /** Pending action items: discoveries awaiting approval. */
  private buildActionItems(): DigestSection | null {
    const pendingDiscoveries = this.operationalDb
      .query(
        `SELECT title, source_type, relevance_score, created_at
         FROM discoveries
         WHERE status IN ('new', 'evaluated')
         ORDER BY relevance_score DESC`,
      )
      .all() as ReadonlyArray<{
      title: string;
      source_type: string;
      relevance_score: number;
      created_at: number;
    }>;

    if (pendingDiscoveries.length === 0) return null;

    const lines: string[] = [];
    lines.push(`- **${pendingDiscoveries.length}** pending approval(s)`);
    lines.push("");

    for (const item of pendingDiscoveries.slice(0, 10)) {
      const score = Math.round(item.relevance_score * 100);
      lines.push(`- [${item.source_type}] ${item.title} (relevance: ${score}%)`);
    }

    if (pendingDiscoveries.length > 10) {
      lines.push(`- ... and ${pendingDiscoveries.length - 10} more`);
    }

    return { title: "Action Items", content: lines.join("\n") };
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
