/**
 * Learning journal: structured log of all learning activity.
 *
 * Provides transparency and auditability by recording discoveries,
 * evaluations, approvals, rejections, implementations, and errors
 * as structured entries that can be exported to markdown.
 *
 * ERR-007: Now supports optional SQLite persistence via operational.db.
 * When a database is provided, entries are written to the learning_journal table
 * on every addEntry() call, surviving daemon restarts.
 * Falls back to in-memory-only when no database is provided (e.g. in tests).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Logger } from "../logging/logger.ts";

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

/** Maximum number of entries that can be retrieved at once. */
const MAX_RECENT_LIMIT = 1000;

/**
 * Sanitize user-sourced text before embedding in Markdown output.
 * Escapes characters that could inject Markdown headings or formatting.
 */
function sanitizeForMarkdown(text: string): string {
  return text.replace(/\n/g, " ").replace(/[#*\->`[\]\\|!()<>]/g, (ch) => `\\${ch}`);
}

let nextEntryId = 0;

/** Generate a unique entry ID. */
function generateEntryId(): string {
  nextEntryId += 1;
  return `journal-${Date.now()}-${nextEntryId}`;
}

/** Valid entry types for DB CHECK constraint validation. */
const VALID_ENTRY_TYPES = new Set<string>([
  "discovery",
  "evaluation",
  "approval",
  "rejection",
  "implementation",
  "error",
]);

export interface LearningJournalOptions {
  readonly maxEntries?: number;
  /** Optional SQLite database (operational.db) for persistence. */
  readonly db?: Database;
}

export class LearningJournal {
  private entries: JournalEntry[];
  private readonly logger: Logger;
  private readonly maxEntries: number;
  private readonly db: Database | null;
  /** ERR-007: Track periodic flush timer for cleanup. */
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(logger: Logger, options?: LearningJournalOptions | number) {
    this.logger = logger;
    // Support legacy signature: constructor(logger, maxEntries?)
    if (typeof options === "number") {
      this.maxEntries = options;
      this.db = null;
    } else {
      this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
      this.db = options?.db ?? null;
    }
    this.entries = [];

    // ERR-007: Load existing entries from DB on startup
    if (this.db) {
      this.loadFromDb();
    }
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

    // ERR-007: Persist to DB immediately
    if (this.db) {
      this.persistEntry(entry);
    }

    this.logger.debug("learning", `Journal entry added: ${type}`, {
      entryId: entry.id,
      title,
    });

    return entry;
  }

  /** Get recent entries, most recent first. */
  getRecent(limit?: number): readonly JournalEntry[] {
    const count = Math.max(1, Math.min(limit ?? 10, MAX_RECENT_LIMIT));
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
      lines.push(`**${typeLabel}: "${sanitizeForMarkdown(entry.title)}"**`);

      if (entry.content.length > 0) {
        lines.push(sanitizeForMarkdown(entry.content));
      }

      // Render metadata inline
      const metaKeys = Object.keys(entry.metadata);
      if (metaKeys.length > 0) {
        const metaParts = metaKeys.map(
          (k) => `${sanitizeForMarkdown(k)}: ${sanitizeForMarkdown(String(entry.metadata[k]))}`,
        );
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

  /** Clear all entries (in-memory and DB). */
  clear(): void {
    this.entries = [];
    if (this.db) {
      try {
        this.db.query("DELETE FROM learning_journal").run();
      } catch (err: unknown) {
        this.logger.error("learning", "Failed to clear journal from DB", err);
      }
    }
    this.logger.debug("learning", "Journal cleared");
  }

  /**
   * Export the journal to a markdown file on disk.
   *
   * Writes to `{journalDir}/YYYY-MM-DD.md` by default, or a custom filename.
   * Creates the directory if it does not exist.
   *
   * @param journalDir - Directory to write journal files to.
   * @param filename - Optional override filename (default: today's date).
   * @returns The full path to the written file, or null on failure.
   */
  exportToFile(journalDir: string, filename?: string): string | null {
    const dateStr = formatDate(new Date()).slice(0, 10); // YYYY-MM-DD
    const fname = filename ?? `${dateStr}.md`;
    const filePath = join(journalDir, fname);

    try {
      mkdirSync(dirname(filePath), { recursive: true });

      // Filter entries for today if using default filename
      let entriesToExport: JournalEntry[];
      if (!filename) {
        entriesToExport = this.entries.filter((e) => {
          const entryDate = formatDate(new Date(e.timestamp)).slice(0, 10);
          return entryDate === dateStr;
        });
      } else {
        entriesToExport = [...this.entries];
      }

      if (entriesToExport.length === 0) {
        this.logger.debug("learning", "No entries to export for this date", { dateStr });
        return null;
      }

      const lines: string[] = [`# Learning Journal - ${dateStr}`, ""];

      // Group entries by type
      const byType = new Map<JournalEntryType, JournalEntry[]>();
      for (const entry of entriesToExport) {
        const existing = byType.get(entry.type) ?? [];
        existing.push(entry);
        byType.set(entry.type, existing);
      }

      // Discoveries
      const discoveries = byType.get("discovery") ?? [];
      if (discoveries.length > 0) {
        lines.push(`## Discoveries (${discoveries.length} items)`);
        for (const d of discoveries) {
          const score = d.metadata.score !== undefined ? ` (score: ${d.metadata.score})` : "";
          lines.push(`- ${sanitizeForMarkdown(d.title)}${score}`);
        }
        lines.push("");
      }

      // Evaluations
      const evaluations = byType.get("evaluation") ?? [];
      if (evaluations.length > 0) {
        lines.push(`## Evaluations (${evaluations.length} items)`);
        for (const e of evaluations) {
          lines.push(`- ${sanitizeForMarkdown(e.title)}: ${sanitizeForMarkdown(e.content)}`);
        }
        lines.push("");
      }

      // Approvals
      const approvals = byType.get("approval") ?? [];
      if (approvals.length > 0) {
        lines.push("## Approvals");
        for (const a of approvals) {
          lines.push(`- ${sanitizeForMarkdown(a.title)}`);
        }
        lines.push("");
      }

      // Rejections
      const rejections = byType.get("rejection") ?? [];
      if (rejections.length > 0) {
        lines.push("## Rejections");
        for (const r of rejections) {
          lines.push(`- ${sanitizeForMarkdown(r.title)}: ${sanitizeForMarkdown(r.content)}`);
        }
        lines.push("");
      }

      // Implementations
      const implementations = byType.get("implementation") ?? [];
      if (implementations.length > 0) {
        lines.push("## Implementations");
        for (const impl of implementations) {
          const branch = impl.metadata.branch ? ` (branch: ${impl.metadata.branch})` : "";
          lines.push(`- ${sanitizeForMarkdown(impl.title)}${branch}`);
          if (impl.content.length > 0) {
            lines.push(`  ${sanitizeForMarkdown(impl.content)}`);
          }
        }
        lines.push("");
      }

      // Errors
      const errors = byType.get("error") ?? [];
      if (errors.length > 0) {
        lines.push("## Errors");
        for (const err of errors) {
          lines.push(`- ${sanitizeForMarkdown(err.title)}: ${sanitizeForMarkdown(err.content)}`);
        }
        lines.push("");
      }

      // Token usage summary from metadata
      let totalTokens = 0;
      for (const entry of entriesToExport) {
        const tokens = entry.metadata.tokensUsed;
        if (typeof tokens === "number") {
          totalTokens += tokens;
        }
      }
      if (totalTokens > 0) {
        lines.push("## Token Usage");
        lines.push(`- Total: ${totalTokens} tokens`);
        lines.push("");
      }

      writeFileSync(filePath, lines.join("\n"), "utf-8");
      this.logger.info("learning", `Journal exported to ${filePath}`, {
        entryCount: entriesToExport.length,
      });

      return filePath;
    } catch (err: unknown) {
      this.logger.error("learning", `Failed to export journal to ${filePath}`, err);
      return null;
    }
  }

  /** ERR-007: Dispose of the journal, clearing any periodic timers. */
  dispose(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private: SQLite persistence
  // ---------------------------------------------------------------------------

  /** Persist a single entry to the database. */
  private persistEntry(entry: JournalEntry): void {
    if (!this.db) return;
    try {
      this.db
        .query(
          "INSERT OR REPLACE INTO learning_journal (id, type, timestamp, title, content, metadata) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(entry.id, entry.type, entry.timestamp, entry.title, entry.content, JSON.stringify(entry.metadata));
    } catch (err: unknown) {
      this.logger.error("learning", `Failed to persist journal entry ${entry.id}`, err);
    }
  }

  /** Load entries from the database on startup. */
  private loadFromDb(): void {
    if (!this.db) return;
    try {
      // Check if the table exists first (might be running before migrations)
      const tableCheck = this.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_journal'")
        .get() as { name: string } | null;
      if (!tableCheck) {
        this.logger.debug("learning", "learning_journal table not found, starting with empty journal");
        return;
      }

      const rows = this.db
        .query("SELECT * FROM learning_journal ORDER BY timestamp ASC LIMIT ?")
        .all(this.maxEntries) as Array<{
        id: string;
        type: string;
        timestamp: number;
        title: string;
        content: string;
        metadata: string;
      }>;

      for (const row of rows) {
        if (!VALID_ENTRY_TYPES.has(row.type)) continue;
        let metadata: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(row.metadata);
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            metadata = parsed as Record<string, unknown>;
          }
        } catch {
          // Use empty metadata on parse failure
        }
        this.entries.push({
          id: row.id,
          type: row.type as JournalEntryType,
          timestamp: row.timestamp,
          title: row.title,
          content: row.content,
          metadata,
        });
      }

      if (this.entries.length > 0) {
        this.logger.info("learning", `Loaded ${this.entries.length} journal entries from DB`);
      }
    } catch (err: unknown) {
      this.logger.error("learning", "Failed to load journal from DB, starting empty", err);
    }
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
