/**
 * eidolon privacy -- GDPR-compliant privacy commands.
 *
 * Subcommands:
 *   forget <entity>  -- cascading delete of all data matching an entity
 *   export           -- export all user data as structured JSON
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
  readonly memoryEdges: unknown[];
  readonly kgEntities: unknown[];
  readonly kgRelations: unknown[];
  readonly sessions: unknown[];
  readonly events: unknown[];
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
// Helpers
// ---------------------------------------------------------------------------

/** Escape LIKE metacharacters to prevent wildcard injection. */
function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// forget command
// ---------------------------------------------------------------------------

function forgetEntity(dbManager: DatabaseManager, entity: string): DeletionReport {
  const deletedCounts: Record<string, number> = {};
  const escaped = escapeLikePattern(entity);
  const pattern = `%${escaped}%`;

  // --- memory.db: wrap all deletes in a single transaction ---
  const memoryTx = dbManager.memory.transaction(() => {
    // 1. memory_edges table -- delete edges BEFORE memories (FK references)
    try {
      const result = dbManager.memory
        .query(
          "DELETE FROM memory_edges WHERE source_id IN (SELECT id FROM memories WHERE content LIKE ? ESCAPE '\\') OR target_id IN (SELECT id FROM memories WHERE content LIKE ? ESCAPE '\\')",
        )
        .run(pattern, pattern);
      deletedCounts.memory_edges = result.changes;
    } catch {
      deletedCounts.memory_edges = 0;
    }

    // 2. memories table -- FTS5 triggers handle memories_fts cleanup automatically
    try {
      const result = dbManager.memory.query("DELETE FROM memories WHERE content LIKE ? ESCAPE '\\'").run(pattern);
      deletedCounts.memories = result.changes;
    } catch {
      deletedCounts.memories = 0;
    }

    // 3. kg_relations table -- uses source_id/target_id FK to kg_entities.id
    try {
      const result = dbManager.memory
        .query(
          "DELETE FROM kg_relations WHERE source_id IN (SELECT id FROM kg_entities WHERE name LIKE ? ESCAPE '\\') OR target_id IN (SELECT id FROM kg_entities WHERE name LIKE ? ESCAPE '\\')",
        )
        .run(pattern, pattern);
      deletedCounts.kg_relations = result.changes;
    } catch {
      deletedCounts.kg_relations = 0;
    }

    // 4. kg_complex_embeddings -- must run BEFORE kg_entities delete so the
    //    subquery can still find matching entity IDs. CASCADE handles the FK,
    //    but predicates referencing the entity may remain. Delete explicitly.
    //    NOTE: After bulk entity deletion, ComplEx model re-training is needed
    //    to maintain embedding consistency.
    try {
      const result = dbManager.memory
        .query(
          "DELETE FROM kg_complex_embeddings WHERE entity_id IN (SELECT id FROM kg_entities WHERE name LIKE ? ESCAPE '\\')",
        )
        .run(pattern);
      deletedCounts.kg_complex_embeddings = result.changes;
    } catch {
      deletedCounts.kg_complex_embeddings = 0;
    }

    // 5. kg_entities table
    try {
      const result = dbManager.memory.query("DELETE FROM kg_entities WHERE name LIKE ? ESCAPE '\\'").run(pattern);
      deletedCounts.kg_entities = result.changes;
    } catch {
      deletedCounts.kg_entities = 0;
    }
  });
  memoryTx();

  // --- operational.db: wrap all deletes in a single transaction ---
  const operationalTx = dbManager.operational.transaction(() => {
    // 6. sessions table -- has metadata column, not messages
    try {
      const result = dbManager.operational.query("DELETE FROM sessions WHERE metadata LIKE ? ESCAPE '\\'").run(pattern);
      deletedCounts.sessions = result.changes;
    } catch {
      deletedCounts.sessions = 0;
    }

    // 7. events table -- payload may contain entity references
    try {
      const result = dbManager.operational.query("DELETE FROM events WHERE payload LIKE ? ESCAPE '\\'").run(pattern);
      deletedCounts.events = result.changes;
    } catch {
      deletedCounts.events = 0;
    }
  });
  operationalTx();

  // --- audit.db: wrap all deletes in a single transaction ---
  const auditTx = dbManager.audit.transaction(() => {
    // 8. audit_log table -- columns: actor, action, target, result, metadata
    try {
      const result = dbManager.audit
        .query(
          "DELETE FROM audit_log WHERE target LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\'",
        )
        .run(pattern, pattern, pattern);
      deletedCounts.audit_log = result.changes;
    } catch {
      deletedCounts.audit_log = 0;
    }
  });
  auditTx();

  // 9. Log the deletion to audit (the action itself -- outside the delete transaction)
  try {
    dbManager.audit
      .query(
        "INSERT INTO audit_log (id, timestamp, actor, action, target, result, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        crypto.randomUUID(),
        Date.now(),
        "system",
        "privacy:forget",
        entity,
        "success",
        JSON.stringify({ deletedCounts }),
      );
  } catch {
    // Best effort -- audit logging should not block the forget operation
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

  // Memories (including accessed_at, access_count, metadata)
  let memories: unknown[] = [];
  try {
    memories = dbManager.memory
      .query(
        "SELECT id, type, layer, content, confidence, source, tags, metadata, accessed_at, access_count, created_at, updated_at FROM memories",
      )
      .all();
    recordCounts.memories = memories.length;
  } catch {
    recordCounts.memories = 0;
  }

  // Memory edges
  let memoryEdges: unknown[] = [];
  try {
    memoryEdges = dbManager.memory
      .query("SELECT source_id, target_id, relation, weight, created_at FROM memory_edges")
      .all();
    recordCounts.memoryEdges = memoryEdges.length;
  } catch {
    recordCounts.memoryEdges = 0;
  }

  // Knowledge graph entities
  let kgEntities: unknown[] = [];
  try {
    kgEntities = dbManager.memory
      .query("SELECT id, name, type, attributes, created_at, updated_at FROM kg_entities")
      .all();
    recordCounts.kgEntities = kgEntities.length;
  } catch {
    recordCounts.kgEntities = 0;
  }

  // Knowledge graph relations
  let kgRelations: unknown[] = [];
  try {
    kgRelations = dbManager.memory
      .query("SELECT id, source_id, target_id, type, confidence, source, created_at FROM kg_relations")
      .all();
    recordCounts.kgRelations = kgRelations.length;
  } catch {
    recordCounts.kgRelations = 0;
  }

  // Sessions
  let sessions: unknown[] = [];
  try {
    sessions = dbManager.operational.query("SELECT id, type, status, started_at, completed_at FROM sessions").all();
    recordCounts.sessions = sessions.length;
  } catch {
    recordCounts.sessions = 0;
  }

  // Events
  let events: unknown[] = [];
  try {
    events = dbManager.operational
      .query("SELECT id, type, timestamp, payload FROM events ORDER BY timestamp DESC")
      .all();
    recordCounts.events = events.length;
  } catch {
    recordCounts.events = 0;
  }

  // Audit log
  let auditLog: unknown[] = [];
  try {
    auditLog = dbManager.audit
      .query("SELECT id, timestamp, actor, action, target, result, metadata FROM audit_log ORDER BY timestamp DESC")
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
    memoryEdges,
    kgEntities,
    kgRelations,
    sessions,
    events,
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
          chmodSync(opts.output, 0o600);
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
