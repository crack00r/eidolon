/**
 * eidolon learning -- self-learning management commands.
 *
 * Subcommands: status, discoveries, approve, reject, journal, sources.
 * Helpers and init logic live in learning-helpers.ts.
 */

import type { Command } from "commander";
import { formatTable } from "../utils/formatter.ts";
import {
  DEFAULT_LIST_LIMIT,
  formatDateOnly,
  initLearningSystem,
  MAX_ID_LENGTH,
  parseSince,
  registerJournalSubcommand,
  registerSourcesSubcommand,
  resolveDiscoveryId,
  shortId,
  truncate,
} from "./learning-helpers.ts";

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
  registerJournalSubcommand(cmd);

  // -- sources --------------------------------------------------------------
  registerSourcesSubcommand(cmd);
}
