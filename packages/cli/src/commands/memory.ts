/**
 * eidolon memory -- memory management commands.
 * Provides search, list, add, delete, stats, dream, and index subcommands.
 */

import { existsSync, statSync } from "node:fs";
import type { Logger } from "@eidolon/core";
import {
  createLogger,
  DatabaseManager,
  DocumentIndexer,
  DreamRunner,
  EmbeddingModel,
  GraphMemory,
  HousekeepingPhase,
  loadConfig,
  MemorySearch,
  MemoryStore,
  NremPhase,
  RemPhase,
} from "@eidolon/core";
import type { EidolonConfig, MemoryLayer, MemoryType } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatTable } from "../utils/formatter.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum length for memory content via CLI (100 KB). */
const MAX_CONTENT_LENGTH = 102_400;

/** Maximum length for CLI search queries. */
const MAX_QUERY_LENGTH = 10_000;

/** Maximum length for individual CLI arguments (tags, IDs, etc.). */
const MAX_ARG_LENGTH = 1_000;

const MEMORY_TYPES: readonly MemoryType[] = [
  "fact",
  "preference",
  "decision",
  "episode",
  "skill",
  "relationship",
  "schema",
];

const VALID_PHASES = ["housekeeping", "rem", "nrem"] as const;
type DreamPhase = (typeof VALID_PHASES)[number];

// ---------------------------------------------------------------------------
// Init helper
// ---------------------------------------------------------------------------

interface MemorySystem {
  readonly config: EidolonConfig;
  readonly logger: Logger;
  readonly db: DatabaseManager;
  readonly store: MemoryStore;
}

async function initMemorySystem(): Promise<MemorySystem | null> {
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
  const store = new MemoryStore(db.memory, logger);
  return { config, logger, db, store };
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

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerMemoryCommand(program: Command): void {
  const cmd = program.command("memory").description("Manage the memory engine");

  // -- search ---------------------------------------------------------------
  cmd
    .command("search <query>")
    .description("Search memories by text")
    .option("--type <type>", "Filter by memory type")
    .option("--limit <n>", "Max results", "10")
    .action(async (query: string, options: { readonly type?: string; readonly limit: string }) => {
      if (query.length > MAX_QUERY_LENGTH) {
        console.error(`Error: query exceeds maximum length of ${MAX_QUERY_LENGTH} characters.`);
        process.exitCode = 1;
        return;
      }
      const sys = await initMemorySystem();
      if (!sys) return;
      try {
        const limit = parseInt(options.limit, 10) || 10;
        const result = sys.store.searchText(query, limit);
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }

        let results = result.value;
        if (options.type) {
          results = results.filter((r) => r.memory.type === options.type);
        }

        if (results.length === 0) {
          console.log("No memories found.");
          return;
        }

        const rows = results.map((r) => ({
          ID: shortId(r.memory.id),
          Type: r.memory.type,
          Content: truncate(r.memory.content.replace(/\n/g, " "), 60),
          Score: r.rank.toFixed(2),
          Date: formatDate(r.memory.createdAt),
        }));
        console.log(formatTable(rows, ["ID", "Type", "Content", "Score", "Date"]));
      } finally {
        sys.db.close();
      }
    });

  // -- list -----------------------------------------------------------------
  cmd
    .command("list")
    .description("List recent memories")
    .option("--type <type>", "Filter by memory type")
    .option("--layer <layer>", "Filter by memory layer")
    .option("--limit <n>", "Max results", "20")
    .action(async (options: { readonly type?: string; readonly layer?: string; readonly limit: string }) => {
      const sys = await initMemorySystem();
      if (!sys) return;
      try {
        const limit = parseInt(options.limit, 10) || 20;
        const types = options.type ? [options.type as MemoryType] : undefined;
        const layers = options.layer ? [options.layer as MemoryLayer] : undefined;

        const result = sys.store.list({
          types,
          layers,
          limit,
          orderBy: "created_at",
          order: "desc",
        });
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }

        if (result.value.length === 0) {
          console.log("No memories found.");
          return;
        }

        const rows = result.value.map((m) => ({
          ID: shortId(m.id),
          Type: m.type,
          Layer: m.layer,
          Content: truncate(m.content.replace(/\n/g, " "), 60),
          Confidence: m.confidence.toFixed(2),
          Created: formatDate(m.createdAt),
        }));
        console.log(formatTable(rows, ["ID", "Type", "Layer", "Content", "Confidence", "Created"]));
      } finally {
        sys.db.close();
      }
    });

  // -- add ------------------------------------------------------------------
  cmd
    .command("add <content>")
    .description("Add a memory manually")
    .option("--type <type>", "Memory type", "fact")
    .option("--confidence <n>", "Confidence 0-1", "0.9")
    .option("--tags <tags>", "Comma-separated tags")
    .action(
      async (
        content: string,
        options: { readonly type: string; readonly confidence: string; readonly tags?: string },
      ) => {
        if (content.length > MAX_CONTENT_LENGTH) {
          console.error(
            `Error: content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters (${content.length}).`,
          );
          process.exitCode = 1;
          return;
        }
        if (options.tags && options.tags.length > MAX_ARG_LENGTH) {
          console.error(`Error: tags argument exceeds maximum length of ${MAX_ARG_LENGTH} characters.`);
          process.exitCode = 1;
          return;
        }
        const sys = await initMemorySystem();
        if (!sys) return;
        try {
          const confidence = parseFloat(options.confidence);
          if (Number.isNaN(confidence) || confidence < 0 || confidence > 1) {
            console.error("Error: confidence must be a number between 0 and 1.");
            process.exitCode = 1;
            return;
          }

          const tags = options.tags ? options.tags.split(",").map((t) => t.trim()) : undefined;
          const result = sys.store.create({
            type: options.type as MemoryType,
            layer: "long_term",
            content,
            confidence,
            source: "manual",
            tags,
          });

          if (!result.ok) {
            console.error(`Error: ${result.error.message}`);
            process.exitCode = 1;
            return;
          }

          console.log(`Memory created: ${result.value.id}`);
        } finally {
          sys.db.close();
        }
      },
    );

  // -- delete ---------------------------------------------------------------
  cmd
    .command("delete <id>")
    .description("Delete a memory by ID")
    .action(async (id: string) => {
      const sys = await initMemorySystem();
      if (!sys) return;
      try {
        const result = sys.store.delete(id);
        if (!result.ok) {
          console.error(`Error: ${result.error.message}`);
          process.exitCode = 1;
          return;
        }
        console.log(`Memory ${id} deleted.`);
      } finally {
        sys.db.close();
      }
    });

  // -- stats ----------------------------------------------------------------
  cmd
    .command("stats")
    .description("Show memory statistics")
    .action(async () => {
      const sys = await initMemorySystem();
      if (!sys) return;
      try {
        const totalResult = sys.store.count();
        if (!totalResult.ok) {
          console.error(`Error: ${totalResult.error.message}`);
          process.exitCode = 1;
          return;
        }

        console.log(`Total memories: ${totalResult.value}`);
        console.log("");

        const rows: Array<Record<string, string>> = [];
        for (const type of MEMORY_TYPES) {
          const countResult = sys.store.count([type]);
          if (countResult.ok) {
            rows.push({ Type: type, Count: String(countResult.value) });
          }
        }
        console.log(formatTable(rows, ["Type", "Count"]));
      } finally {
        sys.db.close();
      }
    });

  // -- dream ----------------------------------------------------------------
  cmd
    .command("dream")
    .description("Trigger a dreaming session manually")
    .option("--phase <phase>", "Run only a specific phase (housekeeping, rem, nrem)")
    .action(async (options: { readonly phase?: string }) => {
      const sys = await initMemorySystem();
      if (!sys) return;
      try {
        if (options.phase && !VALID_PHASES.includes(options.phase as DreamPhase)) {
          console.error(`Error: invalid phase "${options.phase}". Valid: ${VALID_PHASES.join(", ")}`);
          process.exitCode = 1;
          return;
        }

        const graph = new GraphMemory(sys.db.memory, sys.logger);
        const embeddingModel = new EmbeddingModel(sys.logger);
        const search = new MemorySearch(sys.store, embeddingModel, sys.db.memory, sys.logger);
        const housekeeping = new HousekeepingPhase(sys.store, graph, sys.logger);
        const rem = new RemPhase(sys.store, search, graph, null, null, sys.logger);
        const nrem = new NremPhase(sys.store, sys.logger);
        const runner = new DreamRunner(housekeeping, rem, nrem, sys.logger);

        if (options.phase) {
          console.log(`Running ${options.phase} phase...`);
          const result = await runner.runPhase(options.phase as DreamPhase);
          if (!result.ok) {
            console.error(`Error: ${result.error.message}`);
            process.exitCode = 1;
            return;
          }
          printDreamResult(result.value);
        } else {
          console.log("Running all dreaming phases...");
          const result = await runner.runAll();
          if (!result.ok) {
            console.error(`Error: ${result.error.message}`);
            process.exitCode = 1;
            return;
          }
          for (const dr of result.value) {
            printDreamResult(dr);
          }
        }

        console.log("Dream cycle complete.");
      } finally {
        sys.db.close();
      }
    });

  // -- index ----------------------------------------------------------------
  cmd
    .command("index <path>")
    .description("Index a file or directory into memory")
    .action(async (targetPath: string) => {
      const sys = await initMemorySystem();
      if (!sys) return;
      try {
        if (!existsSync(targetPath)) {
          console.error(`Error: path not found: ${targetPath}`);
          process.exitCode = 1;
          return;
        }

        const indexer = new DocumentIndexer(sys.db.memory, sys.store, sys.logger);
        const stat = statSync(targetPath);

        if (stat.isDirectory()) {
          const result = indexer.indexDirectory(targetPath);
          if (!result.ok) {
            console.error(`Error: ${result.error.message}`);
            process.exitCode = 1;
            return;
          }
          console.log(`Indexed ${result.value.files} files (${result.value.chunks} chunks).`);
        } else {
          const result = indexer.indexFile(targetPath);
          if (!result.ok) {
            console.error(`Error: ${result.error.message}`);
            process.exitCode = 1;
            return;
          }
          console.log(`Indexed 1 file (${result.value} chunks).`);
        }
      } finally {
        sys.db.close();
      }
    });
}

// ---------------------------------------------------------------------------
// Dream result formatter
// ---------------------------------------------------------------------------

function printDreamResult(dr: {
  readonly phase: string;
  readonly memoriesProcessed: number;
  readonly memoriesCreated: number;
  readonly memoriesRemoved: number;
  readonly edgesCreated: number;
  readonly completedAt: number;
  readonly startedAt: number;
}): void {
  const durationMs = dr.completedAt - dr.startedAt;
  console.log(
    `  [${dr.phase}] processed=${dr.memoriesProcessed} created=${dr.memoriesCreated} removed=${dr.memoriesRemoved} edges=${dr.edgesCreated} (${durationMs}ms)`,
  );
}
