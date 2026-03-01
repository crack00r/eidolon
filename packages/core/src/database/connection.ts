/**
 * Low-level SQLite connection factory.
 *
 * Creates a Database handle with WAL mode, busy timeout, and foreign keys enabled.
 * Ensures the target directory exists before opening.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

export interface ConnectionOptions {
  readonly walMode?: boolean;
  readonly busyTimeout?: number; // milliseconds
}

/**
 * Create a SQLite database connection with WAL mode and busy timeout.
 */
export function createConnection(path: string, options?: ConnectionOptions): Result<Database, EidolonError> {
  try {
    // Ensure directory exists (unless :memory:)
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    const db = new Database(path, { create: true });

    // Enable WAL mode (better concurrent read performance)
    if (options?.walMode !== false) {
      db.exec("PRAGMA journal_mode=WAL");
    }

    // Set busy timeout (wait rather than fail immediately on lock)
    db.exec(`PRAGMA busy_timeout=${options?.busyTimeout ?? 5000}`);

    // Enable foreign keys
    db.exec("PRAGMA foreign_keys=ON");

    return Ok(db);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_CONNECTION_FAILED, `Failed to open database: ${path}`, cause));
  }
}
