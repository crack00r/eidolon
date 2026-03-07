/**
 * eidolon privacy -- GDPR-compliant privacy commands.
 *
 * Subcommands:
 *   consent          -- manage GDPR consent for memory extraction
 *   forget <entity>  -- cascading delete of all data matching an entity
 *   export           -- export all user data as structured JSON
 *
 * Split into sub-modules:
 *   - privacy-forget.ts -- PRIV-002 entity erasure
 *   - privacy-export.ts -- PRIV-004 data export
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConsentManager, createLogger, DatabaseManager, getDataDir, loadConfig } from "@eidolon/core";
import type { Command } from "commander";
import { exportAllData } from "./privacy-export.ts";
import { forgetEntity } from "./privacy-forget.ts";

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
