/**
 * Advanced memory CLI commands: dream and index.
 *
 * Extracted from memory.ts to keep file sizes manageable.
 */

import { existsSync, statSync } from "node:fs";
import type { Logger } from "@eidolon/core";
import {
  DatabaseManager,
  DocumentIndexer,
  DreamRunner,
  EmbeddingModel,
  GraphMemory,
  HousekeepingPhase,
  MemorySearch,
  MemoryStore,
  NremPhase,
  RemPhase,
} from "@eidolon/core";
import type { EidolonConfig } from "@eidolon/protocol";
import type { Command } from "commander";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const VALID_PHASES = ["housekeeping", "rem", "nrem"] as const;
type DreamPhase = (typeof VALID_PHASES)[number];

interface MemorySystem {
  readonly config: EidolonConfig;
  readonly logger: Logger;
  readonly db: DatabaseManager;
  readonly store: MemoryStore;
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

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

/** Register the "dream" subcommand on a memory command. */
export function registerDreamCommand(cmd: Command, initMemorySystem: () => Promise<MemorySystem | null>): void {
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
}

/** Register the "index" subcommand on a memory command. */
export function registerIndexCommand(cmd: Command, initMemorySystem: () => Promise<MemorySystem | null>): void {
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
          const result = await indexer.indexDirectory(targetPath);
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
