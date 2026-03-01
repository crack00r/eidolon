/**
 * eidolon privacy -- GDPR-compliant privacy commands.
 *
 * Subcommands:
 *   forget <entity>  -- cascading delete of all data matching an entity
 *   export           -- export all user data as structured JSON
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger, DatabaseManager, getDataDir, loadConfig } from "@eidolon/core";
import { VERSION } from "@eidolon/protocol";
import type { Command } from "commander";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeletionReport {
  readonly entity: string;
  readonly timestamp: number;
  readonly deletedCounts: Record<string, number>;
  readonly totalDeleted: number;
}

interface ExportData {
  readonly exportDate: string;
  readonly version: string;
  readonly recordCounts: Record<string, number>;
  readonly memories: unknown[];
  readonly sessions: unknown[];
  readonly auditLog: unknown[];
  readonly config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Database initialization helper
// ---------------------------------------------------------------------------

async function initDatabase(): Promise<DatabaseManager | undefined> {
  const configResult = await loadConfig();
  const loggingConfig = configResult.ok
    ? configResult.value.logging
    : { level: "warn" as const, format: "pretty" as const, directory: "", maxSizeMb: 50, maxFiles: 10 };
  const logger = createLogger(loggingConfig);

  const dbDir = configResult.ok ? configResult.value.database.directory || getDataDir() : getDataDir();

  if (!existsSync(dbDir)) {
    console.error(`Data directory not found: ${dbDir}`);
    return undefined;
  }

  const dbConfig = {
    directory: dbDir,
    walMode: true,
    backupSchedule: "0 3 * * *",
  };

  const dbManager = new DatabaseManager(dbConfig, logger);
  const result = dbManager.initialize();
  if (!result.ok) {
    console.error(`Database initialization failed: ${result.error.message}`);
    return undefined;
  }

  return dbManager;
}

// ---------------------------------------------------------------------------
// forget command
// ---------------------------------------------------------------------------

function forgetEntity(dbManager: DatabaseManager, entity: string): DeletionReport {
  const deletedCounts: Record<string, number> = {};
  const pattern = `%${entity}%`;

  // 1. memories table (memory.db)
  try {
    const result = dbManager.memory.query("DELETE FROM memories WHERE content LIKE ?").run(pattern);
    deletedCounts.memories = result.changes;
  } catch {
    deletedCounts.memories = 0;
  }

  // 2. memory_fts table (memory.db)
  try {
    const result = dbManager.memory.query("DELETE FROM memory_fts WHERE content LIKE ?").run(pattern);
    deletedCounts.memory_fts = result.changes;
  } catch {
    deletedCounts.memory_fts = 0;
  }

  // 3. memory_edges table (memory.db)
  try {
    const result = dbManager.memory
      .query(
        "DELETE FROM memory_edges WHERE source_id IN (SELECT id FROM memories WHERE content LIKE ?) OR target_id IN (SELECT id FROM memories WHERE content LIKE ?)",
      )
      .run(pattern, pattern);
    deletedCounts.memory_edges = result.changes;
  } catch {
    deletedCounts.memory_edges = 0;
  }

  // 4. kg_entities table (memory.db)
  try {
    const result = dbManager.memory.query("DELETE FROM kg_entities WHERE name LIKE ?").run(pattern);
    deletedCounts.kg_entities = result.changes;
  } catch {
    deletedCounts.kg_entities = 0;
  }

  // 5. kg_relations table (memory.db)
  try {
    const result = dbManager.memory
      .query("DELETE FROM kg_relations WHERE head_entity LIKE ? OR tail_entity LIKE ?")
      .run(pattern, pattern);
    deletedCounts.kg_relations = result.changes;
  } catch {
    deletedCounts.kg_relations = 0;
  }

  // 6. sessions table (operational.db)
  try {
    const result = dbManager.operational.query("DELETE FROM sessions WHERE messages LIKE ?").run(pattern);
    deletedCounts.sessions = result.changes;
  } catch {
    deletedCounts.sessions = 0;
  }

  // 7. audit_log table (audit.db)
  try {
    const result = dbManager.audit
      .query("DELETE FROM audit_log WHERE details LIKE ? OR entity LIKE ?")
      .run(pattern, pattern);
    deletedCounts.audit_log = result.changes;
  } catch {
    deletedCounts.audit_log = 0;
  }

  // 8. Log the deletion to audit (the action itself)
  try {
    dbManager.audit
      .query("INSERT INTO audit_log (id, timestamp, action, entity, details) VALUES (?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), Date.now(), "privacy:forget", entity, JSON.stringify({ deletedCounts }));
  } catch {
    // Best effort -- audit table might not have this schema
  }

  const totalDeleted = Object.values(deletedCounts).reduce((sum, n) => sum + n, 0);

  return {
    entity,
    timestamp: Date.now(),
    deletedCounts,
    totalDeleted,
  };
}

// ---------------------------------------------------------------------------
// export command
// ---------------------------------------------------------------------------

function exportAllData(dbManager: DatabaseManager): ExportData {
  const recordCounts: Record<string, number> = {};

  // Memories
  let memories: unknown[] = [];
  try {
    memories = dbManager.memory
      .query("SELECT id, type, layer, content, confidence, source, tags, created_at, updated_at FROM memories")
      .all();
    recordCounts.memories = memories.length;
  } catch {
    recordCounts.memories = 0;
  }

  // Sessions
  let sessions: unknown[] = [];
  try {
    sessions = dbManager.operational.query("SELECT id, type, status, created_at, ended_at FROM sessions").all();
    recordCounts.sessions = sessions.length;
  } catch {
    recordCounts.sessions = 0;
  }

  // Audit log
  let auditLog: unknown[] = [];
  try {
    auditLog = dbManager.audit
      .query("SELECT id, timestamp, action, entity, details FROM audit_log ORDER BY timestamp DESC")
      .all();
    recordCounts.auditLog = auditLog.length;
  } catch {
    recordCounts.auditLog = 0;
  }

  return {
    exportDate: new Date().toISOString(),
    version: VERSION,
    recordCounts,
    memories,
    sessions,
    auditLog,
    config: { note: "Secrets are not included in exports" },
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPrivacyCommand(program: Command): void {
  const cmd = program.command("privacy").description("Privacy and GDPR management");

  // -- forget ---------------------------------------------------------------

  cmd
    .command("forget <entity>")
    .description("Cascading delete of all data matching an entity")
    .action(async (entity: string) => {
      console.log(`Privacy: forgetting entity "${entity}"...\n`);

      const dbManager = await initDatabase();
      if (!dbManager) {
        process.exitCode = 1;
        return;
      }

      try {
        const report = forgetEntity(dbManager, entity);

        console.log("Deletion report:");
        for (const [table, count] of Object.entries(report.deletedCounts)) {
          console.log(`  ${table}: ${count} record(s) deleted`);
        }
        console.log(`\nTotal: ${report.totalDeleted} record(s) deleted.`);

        if (report.totalDeleted === 0) {
          console.log("No records found matching the entity.");
        }
      } finally {
        dbManager.close();
      }
    });

  // -- export ---------------------------------------------------------------

  cmd
    .command("export")
    .description("Export all user data as structured JSON")
    .option("--output <path>", "Output file path (defaults to stdout)")
    .action(async (opts: { output?: string }) => {
      const dbManager = await initDatabase();
      if (!dbManager) {
        process.exitCode = 1;
        return;
      }

      try {
        const data = exportAllData(dbManager);
        const json = JSON.stringify(data, null, 2);

        if (opts.output) {
          const dir = dirname(opts.output);
          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          writeFileSync(opts.output, `${json}\n`, "utf-8");
          console.log(`Data exported to: ${opts.output}`);
          console.log(`Record counts: ${JSON.stringify(data.recordCounts)}`);
        } else {
          process.stdout.write(`${json}\n`);
        }
      } finally {
        dbManager.close();
      }
    });
}
