/**
 * Database initialization for onboarding.
 *
 * Wraps DatabaseManager to create all 3 databases (memory, operational, audit)
 * and reports table counts for verification.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { Err, ErrorCode, Ok, createError } from "@eidolon/protocol";
import { DatabaseManager } from "../database/manager.ts";
import { createLogger } from "../logging/logger.ts";

export interface DbInitResult {
  readonly memoryTables: number;
  readonly operationalTables: number;
  readonly auditTables: number;
}

interface TableCountRow {
  readonly c: number;
}

export function initializeDatabases(directory: string): Result<DbInitResult, EidolonError> {
  const logger = createLogger({
    level: "warn",
    format: "pretty",
    directory: "",
    maxSizeMb: 50,
    maxFiles: 10,
  });
  const dbConfig = { directory, walMode: true, backupSchedule: "0 3 * * *" };

  try {
    const db = new DatabaseManager(dbConfig, logger);
    const initResult = db.initialize();
    if (!initResult.ok) return initResult;

    const countTables = (dbInstance: {
      query: (sql: string) => { all: () => unknown[] };
    }): number => {
      const rows = dbInstance
        .query("SELECT count(*) as c FROM sqlite_master WHERE type='table'")
        .all();
      return (rows[0] as TableCountRow)?.c ?? 0;
    };

    const result: DbInitResult = {
      memoryTables: countTables(db.memory),
      operationalTables: countTables(db.operational),
      auditTables: countTables(db.audit),
    };

    db.close();
    return Ok(result);
  } catch (cause) {
    return Err(
      createError(ErrorCode.DB_CONNECTION_FAILED, `Database init failed: ${cause}`, cause),
    );
  }
}
