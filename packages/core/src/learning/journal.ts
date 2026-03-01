/**
 * Learning journal: structured log of all learning activity.
 *
 * Provides transparency and auditability by recording discoveries,
 * evaluations, approvals, rejections, implementations, and errors
 * as structured entries that can be exported to markdown.
 *
 * TODO: This journal is currently in-memory only. In a future phase, entries
 * should be persisted to the audit database so they survive daemon restarts
 * and can be queried historically.
 */

import type { Logger } from "../logging/logger.js";

export type JournalEntryType = "discovery" | "evaluation" | "approval" | "rejection" | "implementation" | "error";

export interface JournalEntry {
  readonly id: string;
  readonly type: JournalEntryType;
  readonly timestamp: number;
  readonly title: string;
  readonly content: string;
  readonly metadata: Record<string, unknown>;
}

const DEFAULT_MAX_ENTRIES = 10_000;

let nextEntryId = 0;

/** Generate a unique entry ID. */
function generateEntryId(): string {
  nextEntryId += 1;
  return `journal-${Date.now()}-${nextEntryId}`;
}

export class LearningJournal {
  private entries: JournalEntry[];
  private readonly logger: Logger;
  private readonly maxEntries: number;

  constructor(logger: Logger, maxEntries?: number) {
    this.logger = logger;
    this.maxEntries = maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.entries = [];
  }

  /** Add a journal entry. Evicts oldest entries when maxEntries is exceeded. */
  addEntry(type: JournalEntryType, title: string, content: string, metadata?: Record<string, unknown>): JournalEntry {
    const entry: JournalEntry = {
      id: generateEntryId(),
      type,
      timestamp: Date.now(),
      title,
      content,
      metadata: metadata ?? {},
    };

    this.entries.push(entry);

    // Evict oldest entries if over capacity
    if (this.entries.length > this.maxEntries) {
      const excess = this.entries.length - this.maxEntries;
      this.entries.splice(0, excess);
    }

    this.logger.debug("learning", `Journal entry added: ${type}`, {
      entryId: entry.id,
      title,
    });

    return entry;
  }

  /** Get recent entries, most recent first. */
  getRecent(limit?: number): readonly JournalEntry[] {
    const count = limit ?? 10;
    return this.entries.slice(-count).reverse();
  }

  /** Get entries by type, most recent first. */
  getByType(type: JournalEntryType): readonly JournalEntry[] {
    return this.entries.filter((e) => e.type === type).reverse();
  }

  /** Export journal to markdown string. */
  toMarkdown(): string {
    if (this.entries.length === 0) {
      return "# Learning Journal\n\nNo entries yet.\n";
    }

    const lines: string[] = ["# Learning Journal", ""];

    for (const entry of this.entries) {
      const date = new Date(entry.timestamp);
      const dateStr = formatDate(date);
      const typeLabel = capitalizeFirst(entry.type);

      lines.push(`## ${dateStr} — ${typeLabel}`);
      lines.push(`**${typeLabel}: "${entry.title}"**`);

      if (entry.content.length > 0) {
        lines.push(entry.content);
      }

      // Render metadata inline
      const metaKeys = Object.keys(entry.metadata);
      if (metaKeys.length > 0) {
        const metaParts = metaKeys.map((k) => `${k}: ${String(entry.metadata[k])}`);
        lines.push(metaParts.join(" | "));
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  /** Get total entry count. */
  get count(): number {
    return this.entries.length;
  }

  /** Clear all entries. */
  clear(): void {
    this.entries = [];
    this.logger.debug("learning", "Journal cleared");
  }
}

/**
 * Format a Date as "YYYY-MM-DD HH:MM".
 */
function formatDate(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

/** Capitalize the first character of a string. */
function capitalizeFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
