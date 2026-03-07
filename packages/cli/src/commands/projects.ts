/**
 * eidolon projects -- project management CLI commands.
 *
 * Subcommands: list, add, remove, status, journal, sync.
 */

import {
  createLogger,
  DatabaseManager,
  GitAnalyzer,
  loadConfig,
  ProjectJournal,
  ProjectManager,
} from "@eidolon/core";
import type { Logger } from "@eidolon/core";
import type { EidolonConfig } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatTable } from "../utils/formatter.ts";

// ---------------------------------------------------------------------------
// Init helper
// ---------------------------------------------------------------------------

interface ProjectSystem {
  readonly config: EidolonConfig;
  readonly logger: Logger;
  readonly db: DatabaseManager;
  readonly manager: ProjectManager;
  readonly journal: ProjectJournal;
}

async function initProjectSystem(): Promise<ProjectSystem | null> {
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
  const manager = new ProjectManager(db.operational, logger);
  const tablesResult = manager.ensureTables();
  if (!tablesResult.ok) {
    console.error(`Error: ${tablesResult.error.message}`);
    process.exitCode = 1;
    db.close();
    return null;
  }
  const journal = new ProjectJournal(db.operational, logger);
  return { config, logger, db, manager, journal };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatDate(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerProjectsCommand(program: Command): void {
  const cmd = program.command("projects").description("Manage tracked projects");

  // -- list ---------------------------------------------------------------
  cmd
    .command("list")
    .description("List all registered projects")
    .action(async () => {
      const sys = await initProjectSystem();
      if (!sys) return;
      try {
        const result = sys.manager.list();
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }
        const projects = result.value;
        if (projects.length === 0) {
          console.log("No projects registered. Use 'eidolon projects add' to register one.");
          return;
        }
        const rows = projects.map((p) => ({
          Name: p.name,
          Path: truncate(p.repoPath, 50),
          Description: truncate(p.description || "-", 40),
          "Last Sync": formatDate(p.lastSyncedAt),
        }));
        console.log(formatTable(rows, ["Name", "Path", "Description", "Last Sync"]));
      } finally {
        sys.db.close();
      }
    });

  // -- add ----------------------------------------------------------------
  cmd
    .command("add")
    .description("Register a new project")
    .requiredOption("--name <name>", "Project name")
    .requiredOption("--path <path>", "Path to git repository")
    .option("--description <desc>", "Project description")
    .action(async (opts: { name: string; path: string; description?: string }) => {
      const sys = await initProjectSystem();
      if (!sys) return;
      try {
        const result = await sys.manager.create({
          name: opts.name,
          repoPath: opts.path,
          description: opts.description,
        });
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Project "${result.value.name}" registered (ID: ${result.value.id})`);
      } finally {
        sys.db.close();
      }
    });

  // -- remove -------------------------------------------------------------
  cmd
    .command("remove")
    .description("Remove a registered project")
    .argument("<name>", "Project name to remove")
    .action(async (name: string) => {
      const sys = await initProjectSystem();
      if (!sys) return;
      try {
        const lookup = sys.manager.getByName(name);
        if (!lookup.ok) {
          console.error(`Error: ${lookup.error.message}`);
          process.exitCode = 1;
          return;
        }
        if (!lookup.value) {
          console.error(`Project "${name}" not found.`);
          process.exitCode = 1;
          return;
        }
        const result = sys.manager.delete(lookup.value.id);
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Project "${name}" removed.`);
      } finally {
        sys.db.close();
      }
    });

  // -- status -------------------------------------------------------------
  cmd
    .command("status")
    .description("Show status of a project or all projects")
    .argument("[name]", "Project name (omit for all)")
    .action(async (name?: string) => {
      const sys = await initProjectSystem();
      if (!sys) return;
      try {
        if (name) {
          await showProjectStatus(sys, name);
        } else {
          await showAllProjectStatus(sys);
        }
      } finally {
        sys.db.close();
      }
    });

  // -- journal ------------------------------------------------------------
  cmd
    .command("journal")
    .description("Show project journal entries")
    .argument("<name>", "Project name")
    .option("--period <period>", "Filter by period (daily|weekly)")
    .option("--limit <n>", "Number of entries", "10")
    .action(async (name: string, opts: { period?: string; limit: string }) => {
      const sys = await initProjectSystem();
      if (!sys) return;
      try {
        const lookup = sys.manager.getByName(name);
        if (!lookup.ok || !lookup.value) {
          console.error(`Project "${name}" not found.`);
          process.exitCode = 1;
          return;
        }
        const limit = Math.max(1, Math.min(Number.parseInt(opts.limit, 10) || 10, 100));
        const period = opts.period === "daily" || opts.period === "weekly" ? opts.period : undefined;
        const result = sys.journal.getEntries(lookup.value.id, { period, limit });
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }
        if (result.value.length === 0) {
          console.log(`No journal entries for "${name}". Run 'eidolon projects sync' first.`);
          return;
        }
        for (const entry of result.value) {
          console.log(entry.summary);
          console.log(`(${entry.commitCount} commits, ${entry.filesChanged} files changed)`);
          console.log("");
        }
      } finally {
        sys.db.close();
      }
    });

  // -- sync ---------------------------------------------------------------
  cmd
    .command("sync")
    .description("Generate journal entries for all projects")
    .action(async () => {
      const sys = await initProjectSystem();
      if (!sys) return;
      try {
        const listResult = sys.manager.list();
        if (!listResult.ok) {
          console.error(`Error: ${listResult.error.message}`);
          process.exitCode = 1;
          return;
        }
        if (listResult.value.length === 0) {
          console.log("No projects to sync.");
          return;
        }
        const syncResult = await sys.journal.syncAll(listResult.value);
        if (!syncResult.ok) {
          console.error(`Error: ${syncResult.error.message}`);
          process.exitCode = 1;
          return;
        }
        // Mark all projects as synced
        for (const p of listResult.value) {
          sys.manager.markSynced(p.id);
        }
        console.log(`Sync complete. Generated ${syncResult.value} journal entries.`);
      } finally {
        sys.db.close();
      }
    });
}

// ---------------------------------------------------------------------------
// Status display helpers
// ---------------------------------------------------------------------------

async function showProjectStatus(sys: ProjectSystem, name: string): Promise<void> {
  const lookup = sys.manager.getByName(name);
  if (!lookup.ok || !lookup.value) {
    console.error(`Project "${name}" not found.`);
    process.exitCode = 1;
    return;
  }

  const statusResult = await sys.manager.getStatus(lookup.value.id);
  if (!statusResult.ok) {
    console.error(`Error: ${statusResult.error.message}`);
    process.exitCode = 1;
    return;
  }

  const s = statusResult.value;
  console.log(`Project: ${s.project.name}`);
  console.log(`Path: ${s.project.repoPath}`);
  console.log(`Branch: ${s.currentBranch}`);
  console.log(`Branches: ${s.branches.length}`);
  console.log(`Uncommitted changes: ${s.uncommittedChanges}`);
  if (s.aheadBehind) {
    console.log(`Ahead/Behind: +${s.aheadBehind.ahead}/-${s.aheadBehind.behind}`);
  }
  if (s.recentCommits.length > 0) {
    console.log("\nRecent commits:");
    for (const c of s.recentCommits.slice(0, 5)) {
      const d = new Date(c.date).toISOString().slice(0, 10);
      console.log(`  ${c.shortHash} ${d} ${c.message}`);
    }
  }
}

async function showAllProjectStatus(sys: ProjectSystem): Promise<void> {
  const listResult = sys.manager.list();
  if (!listResult.ok) {
    console.error(`Error: ${listResult.error.message}`);
    process.exitCode = 1;
    return;
  }
  if (listResult.value.length === 0) {
    console.log("No projects registered.");
    return;
  }

  const git = new GitAnalyzer(sys.logger);
  const rows: Array<Record<string, string>> = [];

  for (const p of listResult.value) {
    const branchResult = await git.getCurrentBranch(p.repoPath);
    const changesResult = await git.getUncommittedCount(p.repoPath);
    rows.push({
      Name: p.name,
      Branch: branchResult.ok ? branchResult.value : "?",
      Changes: changesResult.ok ? String(changesResult.value) : "?",
      "Last Sync": formatDate(p.lastSyncedAt),
    });
  }

  console.log(formatTable(rows, ["Name", "Branch", "Changes", "Last Sync"]));
}
