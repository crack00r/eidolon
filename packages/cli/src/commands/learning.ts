/**
 * eidolon learning -- self-learning management commands.
 *
 * Subcommands:
 *   status                 -- discovery queue, implemented count, daily stats
 *   discoveries [--since]  -- list recent discoveries with scores
 *   approve <id>           -- approve a pending discovery
 *   reject <id>            -- reject/dismiss a pending discovery
 *   journal [--date]       -- show learning journal entries
 *   sources                -- list configured learning sources
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
const MAX_ID_LENGTH = 200;

/** Default number of discoveries to list. */
const DEFAULT_LIST_LIMIT = 50;

/** Supported --since duration units. */
const DURATION_REGEX = /^(\d+)\s*(d|h|m|w)$/;

// ---------------------------------------------------------------------------
// Init helper
// ---------------------------------------------------------------------------

interface LearningSystem {
  readonly config: EidolonConfig;
  readonly logger: Logger;
  readonly db: DatabaseManager;
  readonly engine: DiscoveryEngine;
  readonly journal: LearningJournal;
}

async function initLearningSystem(): Promise<LearningSystem | null> {
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
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function formatDateOnly(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function formatDateTime(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * Parse a --since duration string (e.g. "7d", "24h", "30m", "2w")
 * into a timestamp (ms since epoch). Returns null on invalid input.
 */
function parseSince(value: string): number | null {
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
// Command registration
// ---------------------------------------------------------------------------

export function registerLearningCommand(program: Command): void {
  const cmd = program.command("learning").description("Manage self-learning capabilities");

  // -- status ---------------------------------------------------------------
  cmd
    .command("status")
    .description("Show discovery queue, implemented count, and daily stats")
    .action(async () => {
      const sys = await initLearningSystem();
      if (!sys) return;
      try {
        const statsResult = sys.engine.getStats();
        if (!statsResult.ok) {
          console.error(`Error: ${statsResult.error.message}`);
          process.exitCode = 1;
          return;
        }

        const stats = statsResult.value;
        const todayResult = sys.engine.countToday();
        const todayCount = todayResult.ok ? todayResult.value : 0;

        const enabled = sys.config.learning.enabled;
        const budget = sys.config.learning.budget;

        console.log(`Self-learning: ${enabled ? "enabled" : "disabled"}`);
        console.log(`Total discoveries: ${stats.total}`);
        console.log(`Today's discoveries: ${todayCount} / ${budget.maxDiscoveriesPerDay} budget`);
        console.log("");

        if (Object.keys(stats.byStatus).length > 0) {
          const rows = Object.entries(stats.byStatus).map(([status, count]) => ({
            Status: status,
            Count: String(count),
          }));
          console.log(formatTable(rows, ["Status", "Count"]));
        } else {
          console.log("No discoveries yet.");
        }

        console.log("");
        console.log(`Journal entries: ${sys.journal.count}`);
      } finally {
        sys.journal.dispose();
        sys.db.close();
      }
    });

  // -- discoveries ----------------------------------------------------------
  cmd
    .command("discoveries")
    .description("List recent discoveries")
    .option("--since <duration>", "Filter by age (e.g. 7d, 24h, 2w)")
    .option("--status <status>", "Filter by status (new, evaluated, approved, rejected, implemented)")
    .option("--limit <n>", "Max results", String(DEFAULT_LIST_LIMIT))
    .action(async (options: { readonly since?: string; readonly status?: string; readonly limit: string }) => {
      const sys = await initLearningSystem();
      if (!sys) return;
      try {
        const limit = Number.parseInt(options.limit, 10);
        if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
          console.error("Error: --limit must be a positive integer between 1 and 1000.");
          process.exitCode = 1;
          return;
        }

        let sinceTs: number | null = null;
        if (options.since) {
          sinceTs = parseSince(options.since);
          if (sinceTs === null) {
            console.error("Error: --since must be a duration like 7d, 24h, 30m, or 2w.");
            process.exitCode = 1;
            return;
          }
        }

        // Query discoveries -- either by status or all statuses
        const statuses: readonly string[] = options.status
          ? [options.status]
          : ["new", "evaluated", "approved", "rejected", "implemented"];

        const allDiscoveries: Array<{
          id: string;
          sourceType: string;
          title: string;
          relevanceScore: number;
          safetyLevel: string;
          status: string;
          createdAt: number;
        }> = [];

        for (const status of statuses) {
          const result = sys.engine.listByStatus(
            status as "new" | "evaluated" | "approved" | "rejected" | "implemented",
            limit,
          );
          if (result.ok) {
            for (const d of result.value) {
              if (sinceTs !== null && d.createdAt < sinceTs) continue;
              allDiscoveries.push(d);
            }
          }
        }

        // Sort by creation time descending, then take the limit
        allDiscoveries.sort((a, b) => b.createdAt - a.createdAt);
        const display = allDiscoveries.slice(0, limit);

        if (display.length === 0) {
          console.log("No discoveries found.");
          return;
        }

        const rows = display.map((d) => ({
          ID: shortId(d.id),
          Source: d.sourceType,
          Title: truncate(d.title.replace(/\n/g, " "), 50),
          Score: d.relevanceScore.toFixed(2),
          Safety: d.safetyLevel,
          Status: d.status,
          Date: formatDateOnly(d.createdAt),
        }));
        console.log(formatTable(rows, ["ID", "Source", "Title", "Score", "Safety", "Status", "Date"]));
      } finally {
        sys.db.close();
      }
    });

  // -- approve --------------------------------------------------------------
  cmd
    .command("approve <id>")
    .description("Approve a pending discovery for implementation")
    .action(async (id: string) => {
      if (id.length > MAX_ID_LENGTH) {
        console.error(`Error: ID exceeds maximum length of ${MAX_ID_LENGTH} characters.`);
        process.exitCode = 1;
        return;
      }
      const sys = await initLearningSystem();
      if (!sys) return;
      try {
        const discovery = resolveDiscoveryId(sys.engine, id);
        if (!discovery.ok) {
          console.error(discovery.error);
          process.exitCode = 1;
          return;
        }

        const disc = discovery.value;
        if (disc.status !== "evaluated" && disc.status !== "new") {
          console.error(`Error: Discovery ${shortId(disc.id)} has status "${disc.status}" and cannot be approved.`);
          console.error('Only discoveries with status "new" or "evaluated" can be approved.');
          process.exitCode = 1;
          return;
        }

        // If status is "new", first move to "evaluated" then to "approved"
        if (disc.status === "new") {
          const evalResult = sys.engine.updateStatus(disc.id, "evaluated");
          if (!evalResult.ok) {
            console.error(`Error: ${evalResult.error.message}`);
            process.exitCode = 1;
            return;
          }
        }

        const result = sys.engine.updateStatus(disc.id, "approved");
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }

        // Record approval in the learning journal
        sys.journal.addEntry("approval", disc.title, `Discovery ${shortId(disc.id)} approved via CLI`, {
          discoveryId: disc.id,
          status: disc.status,
        });

        console.log(`Discovery ${shortId(disc.id)} approved: "${truncate(disc.title, 60)}"`);
      } finally {
        sys.journal.dispose();
        sys.db.close();
      }
    });

  // -- reject ---------------------------------------------------------------
  cmd
    .command("reject <id>")
    .description("Reject/dismiss a pending discovery")
    .action(async (id: string) => {
      if (id.length > MAX_ID_LENGTH) {
        console.error(`Error: ID exceeds maximum length of ${MAX_ID_LENGTH} characters.`);
        process.exitCode = 1;
        return;
      }
      const sys = await initLearningSystem();
      if (!sys) return;
      try {
        const discovery = resolveDiscoveryId(sys.engine, id);
        if (!discovery.ok) {
          console.error(discovery.error);
          process.exitCode = 1;
          return;
        }

        const disc = discovery.value;
        if (disc.status === "rejected") {
          console.log(`Discovery ${shortId(disc.id)} is already rejected.`);
          return;
        }
        if (disc.status === "implemented") {
          console.error(`Error: Discovery ${shortId(disc.id)} is already implemented and cannot be rejected.`);
          process.exitCode = 1;
          return;
        }

        const result = sys.engine.updateStatus(disc.id, "rejected");
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }

        // Record rejection in the learning journal
        sys.journal.addEntry("rejection", disc.title, `Discovery ${shortId(disc.id)} rejected via CLI`, {
          discoveryId: disc.id,
          status: disc.status,
        });

        console.log(`Discovery ${shortId(disc.id)} rejected: "${truncate(disc.title, 60)}"`);
      } finally {
        sys.journal.dispose();
        sys.db.close();
      }
    });

  // -- journal --------------------------------------------------------------
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

        // Filter by date if specified
        if (options.date) {
          const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
          if (!dateRegex.test(options.date)) {
            console.error("Error: --date must be in YYYY-MM-DD format.");
            process.exitCode = 1;
            return;
          }
          entries = entries.filter((e) => formatDateOnly(e.timestamp) === options.date);
        }

        // Filter by type if specified
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

  // -- sources --------------------------------------------------------------
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
        return {
          Type: s.type,
          Schedule: s.schedule,
          Config: truncate(configSummary, 50),
        };
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

type ResolveResult = ResolveOk | ResolveErr;

function resolveDiscoveryId(engine: DiscoveryEngine, idOrPrefix: string): ResolveResult {
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
