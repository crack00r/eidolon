/**
 * Learning journal file export -- extracted from journal.ts.
 *
 * Provides the exportToFile logic that writes journal entries as
 * structured markdown files grouped by entry type.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../logging/logger.ts";
import type { JournalEntry, JournalEntryType } from "./journal.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize user-sourced text before embedding in Markdown output.
 * Escapes characters that could inject Markdown headings or formatting.
 */
export function sanitizeForMarkdown(text: string): string {
  return text.replace(/\n/g, " ").replace(/[#*\->`[\]\\|!()<>]/g, (ch) => `\\${ch}`);
}

/**
 * Format a Date as "YYYY-MM-DD HH:MM".
 */
export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

/** Capitalize the first character of a string. */
export function capitalizeFirst(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// Export logic
// ---------------------------------------------------------------------------

/**
 * Export journal entries to a markdown file on disk.
 *
 * Writes to `{journalDir}/YYYY-MM-DD.md` by default, or a custom filename.
 * Creates the directory if it does not exist.
 *
 * @returns The full path to the written file, or null on failure.
 */
export function exportJournalToFile(
  entries: readonly JournalEntry[],
  journalDir: string,
  logger: Logger,
  filename?: string,
): string | null {
  const dateStr = formatDate(new Date()).slice(0, 10); // YYYY-MM-DD
  const fname = filename ?? `${dateStr}.md`;
  const filePath = join(journalDir, fname);

  try {
    mkdirSync(dirname(filePath), { recursive: true });

    // Filter entries for today if using default filename
    let entriesToExport: readonly JournalEntry[];
    if (!filename) {
      entriesToExport = entries.filter((e) => {
        const entryDate = formatDate(new Date(e.timestamp)).slice(0, 10);
        return entryDate === dateStr;
      });
    } else {
      entriesToExport = entries;
    }

    if (entriesToExport.length === 0) {
      logger.debug("learning", "No entries to export for this date", { dateStr });
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

    appendSection(lines, byType, "discovery", "Discoveries", (d) => {
      const score = d.metadata.score !== undefined ? ` (score: ${d.metadata.score})` : "";
      return `- ${sanitizeForMarkdown(d.title)}${score}`;
    });

    appendSection(
      lines,
      byType,
      "evaluation",
      "Evaluations",
      (e) => `- ${sanitizeForMarkdown(e.title)}: ${sanitizeForMarkdown(e.content)}`,
    );

    appendSection(lines, byType, "approval", "Approvals", (a) => `- ${sanitizeForMarkdown(a.title)}`);

    appendSection(
      lines,
      byType,
      "rejection",
      "Rejections",
      (r) => `- ${sanitizeForMarkdown(r.title)}: ${sanitizeForMarkdown(r.content)}`,
    );

    appendSection(lines, byType, "implementation", "Implementations", (impl) => {
      const branch = impl.metadata.branch ? ` (branch: ${impl.metadata.branch})` : "";
      const line = `- ${sanitizeForMarkdown(impl.title)}${branch}`;
      if (impl.content.length > 0) {
        return `${line}\n  ${sanitizeForMarkdown(impl.content)}`;
      }
      return line;
    });

    appendSection(
      lines,
      byType,
      "error",
      "Errors",
      (err) => `- ${sanitizeForMarkdown(err.title)}: ${sanitizeForMarkdown(err.content)}`,
    );

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
    logger.info("learning", `Journal exported to ${filePath}`, {
      entryCount: entriesToExport.length,
    });

    return filePath;
  } catch (err: unknown) {
    logger.error("learning", `Failed to export journal to ${filePath}`, err);
    return null;
  }
}

/** Append a typed section to the markdown lines array. */
function appendSection(
  lines: string[],
  byType: Map<JournalEntryType, JournalEntry[]>,
  type: JournalEntryType,
  heading: string,
  formatEntry: (entry: JournalEntry) => string,
): void {
  const entries = byType.get(type) ?? [];
  if (entries.length === 0) return;

  const countSuffix = type === "discovery" || type === "evaluation" ? ` (${entries.length} items)` : "";
  lines.push(`## ${heading}${countSuffix}`);
  for (const entry of entries) {
    lines.push(formatEntry(entry));
  }
  lines.push("");
}
