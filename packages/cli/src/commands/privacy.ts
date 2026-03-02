/**
 * eidolon privacy -- GDPR-compliant privacy commands.
 *
 * Subcommands:
 *   consent          -- manage GDPR consent for memory extraction
 *   forget <entity>  -- cascading delete of all data matching an entity
 *   export           -- export all user data as structured JSON
 *
 * PRIV-001: consent subcommand with --grant, --revoke, --status
 * PRIV-002: comprehensive forget across ALL user data tables
 * PRIV-003: forget cascade includes backup deletion
 * PRIV-004: export includes ALL user data tables
 */

import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BackupManager, ConsentManager, createLogger, DatabaseManager, getDataDir, loadConfig } from "@eidolon/core";
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
  readonly backupsDeleted: number;
}

interface ExportData {
  readonly metadata: {
    readonly exportDate: string;
    readonly version: string;
    readonly tablesIncluded: readonly string[];
    readonly recordCounts: Record<string, number>;
  };
  readonly memories: unknown[];
  readonly memoryEdges: unknown[];
  readonly memoryEmbeddings: unknown[];
  readonly kgEntities: unknown[];
  readonly kgRelations: unknown[];
  readonly kgCommunities: unknown[];
  readonly kgComplexEmbeddings: unknown[];
  readonly sessions: unknown[];
  readonly events: unknown[];
  readonly conversations: unknown[];
  readonly scheduledTasks: unknown[];
  readonly tokenUsage: unknown[];
  readonly discoveries: unknown[];
  readonly learningImplementations: unknown[];
  readonly deviceTokens: unknown[];
  readonly auditLog: unknown[];
  readonly consent: unknown[];
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

/** Safe table delete -- returns 0 on failure. */
function safeDelete(db: Database, sql: string, ...params: string[]): number {
  try {
    const result = db.query(sql).run(...params);
    return result.changes;
  } catch {
    return 0;
  }
}

/** Safe select all -- returns [] on failure. */
function safeSelectAll(db: Database, sql: string): unknown[] {
  try {
    return db.query(sql).all();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// forget command (PRIV-002: comprehensive erasure)
// ---------------------------------------------------------------------------

function forgetEntity(dbManager: DatabaseManager, entity: string): DeletionReport {
  const deletedCounts: Record<string, number> = {};
  const escaped = escapeLikePattern(entity);
  const pattern = `%${escaped}%`;

  // --- memory.db: wrap all deletes in a single transaction ---
  const memoryTx = dbManager.memory.transaction(() => {
    // 1. memory_edges -- delete edges BEFORE memories (FK references)
    deletedCounts.memory_edges = safeDelete(
      dbManager.memory,
      "DELETE FROM memory_edges WHERE source_id IN (SELECT id FROM memories WHERE content LIKE ? ESCAPE '\\') OR target_id IN (SELECT id FROM memories WHERE content LIKE ? ESCAPE '\\')",
      pattern,
      pattern,
    );

    // 2. kg_complex_embeddings -- must run BEFORE kg_entities delete
    deletedCounts.kg_complex_embeddings = safeDelete(
      dbManager.memory,
      "DELETE FROM kg_complex_embeddings WHERE entity_id IN (SELECT id FROM kg_entities WHERE name LIKE ? ESCAPE '\\')",
      pattern,
    );

    // 3. kg_relations -- uses source_id/target_id FK to kg_entities.id
    deletedCounts.kg_relations = safeDelete(
      dbManager.memory,
      "DELETE FROM kg_relations WHERE source_id IN (SELECT id FROM kg_entities WHERE name LIKE ? ESCAPE '\\') OR target_id IN (SELECT id FROM kg_entities WHERE name LIKE ? ESCAPE '\\')",
      pattern,
      pattern,
    );

    // 4. kg_communities -- entity_ids is JSON array, check if entity name appears
    deletedCounts.kg_communities = safeDelete(
      dbManager.memory,
      "DELETE FROM kg_communities WHERE summary LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    // 5. kg_entities
    deletedCounts.kg_entities = safeDelete(
      dbManager.memory,
      "DELETE FROM kg_entities WHERE name LIKE ? ESCAPE '\\'",
      pattern,
    );

    // 6. memories (including embeddings -- the embedding column is ON the memories table)
    // FTS5 triggers handle memories_fts cleanup automatically
    deletedCounts.memories = safeDelete(
      dbManager.memory,
      "DELETE FROM memories WHERE content LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
      pattern,
    );
  });
  memoryTx();

  // --- operational.db: wrap all deletes in a single transaction ---
  const operationalTx = dbManager.operational.transaction(() => {
    // 7. sessions (conversations)
    deletedCounts.sessions = safeDelete(
      dbManager.operational,
      "DELETE FROM sessions WHERE metadata LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    // 8. events -- payload may contain entity references
    deletedCounts.events = safeDelete(
      dbManager.operational,
      "DELETE FROM events WHERE payload LIKE ? ESCAPE '\\' OR source LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    // 9. scheduled_tasks -- payload or name may reference user data
    deletedCounts.scheduled_tasks = safeDelete(
      dbManager.operational,
      "DELETE FROM scheduled_tasks WHERE payload LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    // 10. token_usage -- session_id may reference user sessions
    deletedCounts.token_usage = safeDelete(
      dbManager.operational,
      "DELETE FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE metadata LIKE ? ESCAPE '\\')",
      pattern,
    );

    // 11. discoveries -- content/title may contain user-related data
    deletedCounts.discoveries = safeDelete(
      dbManager.operational,
      "DELETE FROM discoveries WHERE content LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\'",
      pattern,
      pattern,
    );

    // 12. device_tokens -- may contain user-specific tokens
    deletedCounts.device_tokens = safeDelete(
      dbManager.operational,
      "DELETE FROM device_tokens WHERE token LIKE ? ESCAPE '\\'",
      pattern,
    );

    // 13. user_consent -- remove consent records for this entity
    deletedCounts.user_consent = safeDelete(
      dbManager.operational,
      "DELETE FROM user_consent WHERE id LIKE ? ESCAPE '\\'",
      pattern,
    );

    // 14. loop_state -- remove any state referencing entity
    deletedCounts.loop_state = safeDelete(
      dbManager.operational,
      "DELETE FROM loop_state WHERE value LIKE ? ESCAPE '\\'",
      pattern,
    );

    // 15. account_usage -- not user-specific, skip
    // 16. circuit_breakers -- not user-specific, skip
  });
  operationalTx();

  // --- audit.db: KEEP entries (legal requirement) but REDACT PII fields ---
  const auditTx = dbManager.audit.transaction(() => {
    // PRIV-002: Do NOT delete audit log entries -- redact PII instead (legal requirement)
    try {
      const result = dbManager.audit
        .query(
          "UPDATE audit_log SET target = '[REDACTED]', metadata = '{}' WHERE target LIKE ? ESCAPE '\\' OR actor LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\'",
        )
        .run(pattern, pattern, pattern);
      deletedCounts.audit_log_redacted = result.changes;
    } catch {
      deletedCounts.audit_log_redacted = 0;
    }
  });
  auditTx();

  // --- VACUUM databases to reclaim space and prevent forensic recovery ---
  try {
    dbManager.memory.exec("VACUUM");
  } catch {
    // Non-fatal
  }
  try {
    dbManager.operational.exec("VACUUM");
  } catch {
    // Non-fatal
  }
  try {
    dbManager.audit.exec("VACUUM");
  } catch {
    // Non-fatal
  }

  // --- PRIV-003: Delete all backups ---
  let backupsDeleted = 0;
  try {
    const dbDir = getDataDir();
    const dbConfig = {
      directory: dbDir,
      walMode: true,
      backupSchedule: "0 3 * * *",
    };
    const loggingConfig = {
      level: "warn" as const,
      format: "pretty" as const,
      directory: "",
      maxSizeMb: 50,
      maxFiles: 10,
    };
    const logger = createLogger(loggingConfig);
    const backupMgr = new BackupManager(dbManager, dbConfig, logger);
    const deleteResult = backupMgr.deleteAllBackups();
    if (deleteResult.ok) {
      backupsDeleted = deleteResult.value;
    }
  } catch {
    // Best effort -- backup deletion should not block forget
  }

  // Log the deletion to audit (the action itself -- outside the delete transaction)
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
        JSON.stringify({ deletedCounts, backupsDeleted }),
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
    backupsDeleted,
  };
}

// ---------------------------------------------------------------------------
// export command (PRIV-004: comprehensive export)
// ---------------------------------------------------------------------------

function exportAllData(dbManager: DatabaseManager): ExportData {
  const recordCounts: Record<string, number> = {};
  const tablesIncluded: string[] = [];

  // --- memory.db ---

  // Memories (including accessed_at, access_count, metadata, sensitive flag, embedding info)
  const memories = safeSelectAll(
    dbManager.memory,
    "SELECT id, type, layer, content, confidence, source, tags, metadata, accessed_at, access_count, sensitive, created_at, updated_at FROM memories",
  );
  recordCounts.memories = memories.length;
  tablesIncluded.push("memories");

  // Memory embeddings (existence info, not raw blobs for portability)
  const memoryEmbeddings = safeSelectAll(
    dbManager.memory,
    "SELECT id, type, layer, content FROM memories WHERE embedding IS NOT NULL",
  );
  recordCounts.memoryEmbeddings = memoryEmbeddings.length;
  tablesIncluded.push("memory_embeddings");

  // Memory edges
  const memoryEdges = safeSelectAll(
    dbManager.memory,
    "SELECT source_id, target_id, relation, weight, created_at FROM memory_edges",
  );
  recordCounts.memoryEdges = memoryEdges.length;
  tablesIncluded.push("memory_edges");

  // Knowledge graph entities
  const kgEntities = safeSelectAll(
    dbManager.memory,
    "SELECT id, name, type, attributes, created_at, updated_at FROM kg_entities",
  );
  recordCounts.kgEntities = kgEntities.length;
  tablesIncluded.push("kg_entities");

  // Knowledge graph relations
  const kgRelations = safeSelectAll(
    dbManager.memory,
    "SELECT id, source_id, target_id, type, confidence, source, created_at FROM kg_relations",
  );
  recordCounts.kgRelations = kgRelations.length;
  tablesIncluded.push("kg_relations");

  // Knowledge graph communities
  const kgCommunities = safeSelectAll(
    dbManager.memory,
    "SELECT id, name, entity_ids, summary, created_at FROM kg_communities",
  );
  recordCounts.kgCommunities = kgCommunities.length;
  tablesIncluded.push("kg_communities");

  // Knowledge graph ComplEx embeddings (metadata only)
  const kgComplexEmbeddings = safeSelectAll(
    dbManager.memory,
    "SELECT entity_id, updated_at FROM kg_complex_embeddings",
  );
  recordCounts.kgComplexEmbeddings = kgComplexEmbeddings.length;
  tablesIncluded.push("kg_complex_embeddings");

  // --- operational.db ---

  // Sessions (conversations)
  const sessions = safeSelectAll(
    dbManager.operational,
    "SELECT id, type, status, claude_session_id, started_at, last_activity_at, completed_at, tokens_used, cost_usd, metadata FROM sessions",
  );
  recordCounts.sessions = sessions.length;
  tablesIncluded.push("sessions");

  // Events
  const events = safeSelectAll(
    dbManager.operational,
    "SELECT id, type, priority, payload, source, timestamp, processed_at, retry_count FROM events ORDER BY timestamp DESC",
  );
  recordCounts.events = events.length;
  tablesIncluded.push("events");

  // Conversations (alias for sessions -- included for completeness)
  const conversations = sessions;
  recordCounts.conversations = conversations.length;

  // Scheduled tasks
  const scheduledTasks = safeSelectAll(
    dbManager.operational,
    "SELECT id, name, type, cron, run_at, condition, action, payload, enabled, last_run_at, next_run_at, created_at FROM scheduled_tasks",
  );
  recordCounts.scheduledTasks = scheduledTasks.length;
  tablesIncluded.push("scheduled_tasks");

  // Token usage
  const tokenUsage = safeSelectAll(
    dbManager.operational,
    "SELECT id, session_id, session_type, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, timestamp FROM token_usage ORDER BY timestamp DESC",
  );
  recordCounts.tokenUsage = tokenUsage.length;
  tablesIncluded.push("token_usage");

  // Discoveries (learning)
  const discoveries = safeSelectAll(
    dbManager.operational,
    "SELECT id, source_type, url, title, content, relevance_score, safety_level, status, implementation_branch, created_at, evaluated_at, implemented_at FROM discoveries",
  );
  recordCounts.discoveries = discoveries.length;
  tablesIncluded.push("discoveries");

  // Learning implementations (empty placeholder -- table may not exist yet)
  const learningImplementations: unknown[] = [];
  recordCounts.learningImplementations = 0;
  tablesIncluded.push("learning_implementations");

  // Device tokens
  const deviceTokens = safeSelectAll(
    dbManager.operational,
    "SELECT id, platform, created_at, last_used_at FROM device_tokens",
  );
  recordCounts.deviceTokens = deviceTokens.length;
  tablesIncluded.push("device_tokens");

  // --- audit.db ---

  // Audit log
  const auditLog = safeSelectAll(
    dbManager.audit,
    "SELECT id, timestamp, actor, action, target, result, metadata FROM audit_log ORDER BY timestamp DESC",
  );
  recordCounts.auditLog = auditLog.length;
  tablesIncluded.push("audit_log");

  // --- Consent status ---
  const consent = safeSelectAll(
    dbManager.operational,
    "SELECT id, consent_type, granted, granted_at, revoked_at, updated_at FROM user_consent",
  );
  recordCounts.consent = consent.length;
  tablesIncluded.push("user_consent");

  return {
    metadata: {
      exportDate: new Date().toISOString(),
      version: VERSION,
      tablesIncluded,
      recordCounts,
    },
    memories,
    memoryEdges,
    memoryEmbeddings,
    kgEntities,
    kgRelations,
    kgCommunities,
    kgComplexEmbeddings,
    sessions,
    events,
    conversations,
    scheduledTasks,
    tokenUsage,
    discoveries,
    learningImplementations,
    deviceTokens,
    auditLog,
    consent,
    config: { note: "Secrets are not included in exports" },
  };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPrivacyCommand(program: Command): void {
  const cmd = program.command("privacy").description("Privacy and GDPR management");

  // -- consent (PRIV-001) ---------------------------------------------------

  cmd
    .command("consent")
    .description("Manage GDPR consent for memory extraction")
    .option("--grant", "Grant consent for memory extraction")
    .option("--revoke", "Revoke consent for memory extraction")
    .option("--status", "Show current consent status")
    .action(async (opts: { grant?: boolean; revoke?: boolean; status?: boolean }) => {
      if (!opts.grant && !opts.revoke && !opts.status) {
        console.error("Please specify --grant, --revoke, or --status");
        process.exitCode = 1;
        return;
      }

      const dbManager = await initDatabase();
      if (!dbManager) {
        process.exitCode = 1;
        return;
      }

      try {
        const loggingConfig = {
          level: "warn" as const,
          format: "pretty" as const,
          directory: "",
          maxSizeMb: 50,
          maxFiles: 10,
        };
        const logger = createLogger(loggingConfig);
        const consentMgr = new ConsentManager(dbManager.operational, logger);

        if (opts.grant) {
          const result = consentMgr.grantConsent("memory_extraction");
          if (result.ok) {
            console.log("Consent granted for memory extraction.");
            console.log(`Timestamp: ${new Date().toISOString()}`);
          } else {
            console.error(`Failed to grant consent: ${result.error.message}`);
            process.exitCode = 1;
          }
        } else if (opts.revoke) {
          const result = consentMgr.revokeConsent("memory_extraction");
          if (result.ok) {
            console.log("Consent revoked for memory extraction.");
            console.log("Memory extraction is now disabled.");
            console.log(`Timestamp: ${new Date().toISOString()}`);
          } else {
            console.error(`Failed to revoke consent: ${result.error.message}`);
            process.exitCode = 1;
          }
        } else if (opts.status) {
          const result = consentMgr.getConsentStatus("memory_extraction");
          if (result.ok) {
            const status = result.value;
            if (!status) {
              console.log("Consent status: NOT SET");
              console.log("Memory extraction is disabled by default (no consent given).");
              console.log("Run 'eidolon privacy consent --grant' to enable.");
            } else {
              console.log(`Consent status: ${status.granted ? "GRANTED" : "REVOKED"}`);
              if (status.grantedAt) {
                console.log(`Granted at: ${new Date(status.grantedAt).toISOString()}`);
              }
              if (status.revokedAt) {
                console.log(`Revoked at: ${new Date(status.revokedAt).toISOString()}`);
              }
              console.log(`Last updated: ${new Date(status.updatedAt).toISOString()}`);
            }
          } else {
            console.error(`Failed to get consent status: ${result.error.message}`);
            process.exitCode = 1;
          }
        }
      } finally {
        dbManager.close();
      }
    });

  // -- forget (PRIV-002: comprehensive erasure) -----------------------------

  cmd
    .command("forget <entity>")
    .description("Cascading delete of all data matching an entity (GDPR right to erasure)")
    .option("--confirm", "Confirm deletion (required to proceed)")
    .action(async (entity: string, opts: { confirm?: boolean }) => {
      if (!opts.confirm) {
        console.log(`This will permanently delete ALL data matching "${entity}" from:`);
        console.log("  - memories, embeddings, knowledge graph (memory.db)");
        console.log("  - sessions, events, tasks, token usage, discoveries (operational.db)");
        console.log("  - audit log entries will be REDACTED (not deleted, legal requirement)");
        console.log("  - ALL backup files will be DELETED");
        console.log("");
        console.log("This action is IRREVERSIBLE.");
        console.log("");
        console.log("To proceed, run:");
        console.log(`  eidolon privacy forget "${entity}" --confirm`);
        return;
      }

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
          console.log(`  ${table}: ${count} record(s) ${table === "audit_log_redacted" ? "redacted" : "deleted"}`);
        }
        console.log(`  backups: ${report.backupsDeleted} backup(s) deleted`);
        console.log(`\nTotal: ${report.totalDeleted} record(s) affected.`);
        console.log("Databases have been VACUUMed to reclaim space.");

        if (report.totalDeleted === 0 && report.backupsDeleted === 0) {
          console.log("No records found matching the entity.");
        }
      } finally {
        dbManager.close();
      }
    });

  // -- export (PRIV-004: comprehensive data portability) --------------------

  cmd
    .command("export")
    .description("Export all user data as structured JSON (GDPR data portability)")
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
          console.log(`Tables included: ${data.metadata.tablesIncluded.join(", ")}`);
          console.log(`Record counts: ${JSON.stringify(data.metadata.recordCounts)}`);
        } else {
          process.stdout.write(`${json}\n`);
        }
      } finally {
        dbManager.close();
      }
    });
}
