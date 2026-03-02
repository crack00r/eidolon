/**
 * Migration runner for SQLite databases.
 *
 * Applies pending migrations in version order within individual transactions.
 * Tracks applied migrations in a `_migrations` table.
 */

import type { Database } from "bun:sqlite";
import type { DatabaseName, EidolonError, Migration, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

/**
 * Run migrations on a database. Applies only migrations not yet applied.
 * Each migration is applied within its own transaction (all or nothing).
 */
export function runMigrations(
  db: Database,
  dbName: DatabaseName,
  migrations: ReadonlyArray<Migration>,
  logger: Logger,
): Result<number, EidolonError> {
  // Create migrations tracking table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  // Get current version
  const currentRow = db.query("SELECT MAX(version) as version FROM _migrations").get() as {
    version: number | null;
  } | null;
  const currentVersion = currentRow?.version ?? 0;

  // Filter to unapplied migrations for this database
  const pending = migrations
    .filter((m) => m.database === dbName && m.version > currentVersion)
    .toSorted((a, b) => a.version - b.version);

  if (pending.length === 0) {
    logger.debug("migrations", `No pending migrations for ${dbName}`);
    return Ok(0);
  }

  const applied: number[] = [];
  for (const migration of pending) {
    try {
      db.exec("BEGIN TRANSACTION");
      db.exec(migration.up);
      db.query("INSERT INTO _migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        Date.now(),
      );
      db.exec("COMMIT");
      applied.push(migration.version);
      logger.info("migrations", `Applied migration ${migration.version}: ${migration.name} to ${dbName}`);
    } catch (cause) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Rollback may fail if transaction was already aborted
      }
      return Err(
        createError(
          ErrorCode.DB_MIGRATION_FAILED,
          `Migration ${migration.version} (${migration.name}) failed on ${dbName}`,
          cause,
        ),
      );
    }
  }

  return Ok(applied.length);
}
