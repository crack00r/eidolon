/**
 * Helpers for eidolon learning CLI commands.
 *
 * Extracted from learning.ts to keep it under 300 lines.
 * Contains: init factory, formatting helpers, ID resolution.
 */

import type { Logger } from "@eidolon/core";
import { createLogger, DatabaseManager, DiscoveryEngine, LearningJournal, loadConfig } from "@eidolon/core";
import type { EidolonConfig } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatTable } from "../utils/formatter.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length for an ID argument on the CLI. */
export const MAX_ID_LENGTH = 200;

/** Default number of discoveries to list. */
export const DEFAULT_LIST_LIMIT = 50;

/** Supported --since duration units. */
const DURATION_REGEX = /^(\d+)\s*(d|h|m|w)$/;

// ---------------------------------------------------------------------------
// Init helper
// ---------------------------------------------------------------------------

export interface LearningSystem {
  readonly config: EidolonConfig;
  readonly logger: Logger;
  readonly db: DatabaseManager;
  readonly engine: DiscoveryEngine;
  readonly journal: LearningJournal;
}

export async function initLearningSystem(): Promise<LearningSystem | null> {
  const configResult = await loadConfig();
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    process.exitCode = 1;
    return null;
  }
  const config = configResult.value;
  const logger = createLogger(config.logging);
  const db = new DatabaseManager(config.database, logger);
  const initResult = db.initialize();
  if (!initResult.ok) {
    console.error(`Error: ${initResult.error.message}`);
    process.exitCode = 1;
    return null;
  }
  const engine = new DiscoveryEngine(db.operational, logger);
  const journal = new LearningJournal(logger, { db: db.operational });
  return { config, logger, db, engine, journal };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatDateOnly(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Parse a --since duration string (e.g. "7d", "24h", "30m", "2w")
 * into a timestamp (ms since epoch). Returns null on invalid input.
 */
export function parseSince(value: string): number | null {
  const match = DURATION_REGEX.exec(value.trim());
  if (!match) return null;

  const amountStr = match[1];
  const unit = match[2];
  if (amountStr === undefined || unit === undefined) return null;

  const amount = Number.parseInt(amountStr, 10);
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const multipliers: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };

  const ms = multipliers[unit];
  if (ms === undefined) return null;

  return Date.now() - amount * ms;
}

// ---------------------------------------------------------------------------
// Discovery ID resolution (supports prefix matching)
// ---------------------------------------------------------------------------

interface ResolveOk {
  readonly ok: true;
  readonly value: {
    readonly id: string;
    readonly title: string;
    readonly status: string;
  };
}

interface ResolveErr {
  readonly ok: false;
  readonly error: string;
}

export type ResolveResult = ResolveOk | ResolveErr;

export function resolveDiscoveryId(engine: DiscoveryEngine, idOrPrefix: string): ResolveResult {
  // Try exact match first
  const exactResult = engine.get(idOrPrefix);
  if (exactResult.ok && exactResult.value) {
    return { ok: true, value: exactResult.value };
  }

  // Try prefix match across all statuses
  const allStatuses = ["new", "evaluated", "approved", "rejected", "implemented"] as const;
  const matches: Array<{ id: string; title: string; status: string }> = [];

  for (const status of allStatuses) {
    const listResult = engine.listByStatus(status, 1000);
    if (listResult.ok) {
      for (const d of listResult.value) {
        if (d.id.startsWith(idOrPrefix)) {
          matches.push(d);
        }
      }
    }
  }

  if (matches.length === 0) {
    return { ok: false, error: `Error: Discovery not found: ${idOrPrefix}` };
  }

  if (matches.length > 1) {
    const ids = matches.map((m) => `  ${shortId(m.id)} (${m.status}): ${truncate(m.title, 40)}`).join("\n");
    return {
      ok: false,
      error: `Error: Ambiguous ID prefix "${idOrPrefix}" matches ${matches.length} discoveries:\n${ids}\nPlease provide a longer ID prefix.`,
    };
  }

  const match = matches[0];
  if (match === undefined) {
    return { ok: false, error: `Error: Discovery not found: ${idOrPrefix}` };
  }
  return { ok: true, value: match };
}

// ---------------------------------------------------------------------------
// Subcommand registrations (extracted to keep learning.ts under 300 lines)
// ---------------------------------------------------------------------------

export function registerJournalSubcommand(cmd: Command): void {
  cmd
    .command("journal")
    .description("Show learning journal entries")
    .option("--date <date>", "Filter by date (YYYY-MM-DD)")
    .option("--type <type>", "Filter by entry type (discovery, evaluation, approval, rejection, implementation, error)")
    .option("--limit <n>", "Max entries", "20")
    .action(async (options: { readonly date?: string; readonly type?: string; readonly limit: string }) => {
      const sys = await initLearningSystem();
      if (!sys) return;
      try {
        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
          console.error("Error: --limit must be a positive integer between 1 and 1000.");
          process.exitCode = 1;
          return;
        }

        let entries = [...sys.journal.getRecent(limit)];

        if (options.date) {
          const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
          if (!dateRegex.test(options.date)) {
            console.error("Error: --date must be in YYYY-MM-DD format.");
            process.exitCode = 1;
            return;
          }
          entries = entries.filter((e) => formatDateOnly(e.timestamp) === options.date);
        }

        if (options.type) {
          const validTypes = new Set(["discovery", "evaluation", "approval", "rejection", "implementation", "error"]);
          if (!validTypes.has(options.type)) {
            console.error(`Error: invalid type "${options.type}". Valid: ${[...validTypes].join(", ")}`);
            process.exitCode = 1;
            return;
          }
          entries = entries.filter((e) => e.type === options.type);
        }

        if (entries.length === 0) {
          console.log("No journal entries found.");
          return;
        }

        const rows = entries.map((e) => ({
          ID: shortId(e.id),
          Type: e.type,
          Title: truncate(e.title.replace(/\n/g, " "), 50),
          Content: truncate(e.content.replace(/\n/g, " "), 40),
          Date: formatDateTime(e.timestamp),
        }));
        console.log(formatTable(rows, ["ID", "Type", "Title", "Content", "Date"]));
      } finally {
        sys.journal.dispose();
        sys.db.close();
      }
    });
}

export function registerSourcesSubcommand(cmd: Command): void {
  cmd
    .command("sources")
    .description("List configured learning sources")
    .action(async () => {
      const configResult = await loadConfig();
      if (!configResult.ok) {
        console.error(`Error: ${configResult.error.message}`);
        process.exitCode = 1;
        return;
      }
      const config = configResult.value;
      const sources = config.learning.sources;

      if (sources.length === 0) {
        console.log("No learning sources configured.");
        console.log('Add sources in eidolon.json under "learning.sources".');
        return;
      }

      const rows = sources.map((s) => {
        const configSummary = Object.entries(s.config)
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(", ");
        return { Type: s.type, Schedule: s.schedule, Config: truncate(configSummary, 50) };
      });
      console.log(formatTable(rows, ["Type", "Schedule", "Config"]));

      console.log("");
      console.log(`Relevance threshold: ${config.learning.relevance.minScore}`);
      console.log(`User interests: ${config.learning.relevance.userInterests.join(", ") || "(none)"}`);
      console.log(`Auto-implement: ${config.learning.autoImplement.enabled ? "enabled" : "disabled"}`);
      console.log(
        `Daily budget: ${config.learning.budget.maxDiscoveriesPerDay} discoveries, ${config.learning.budget.maxTokensPerDay} tokens`,
      );
    });
}
