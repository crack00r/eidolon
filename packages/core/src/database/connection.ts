/**
 * Low-level SQLite connection factory.
 *
 * Creates a Database handle with WAL mode, busy timeout, and foreign keys enabled.
 * Ensures the target directory exists before opening.
 */

import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

/** Default busy timeout in milliseconds. */
const DEFAULT_BUSY_TIMEOUT_MS = 5000;

/** WAL autocheckpoint threshold in pages. */
const WAL_AUTOCHECKPOINT_PAGES = 1000;

/** Restrictive file permissions for database files (owner read/write only). */
const DB_FILE_PERMISSIONS = 0o600;

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

    try {
      // Enable WAL mode (better concurrent read performance)
      if (options?.walMode !== false) {
        db.exec("PRAGMA journal_mode=WAL");
      }

      // Set busy timeout (wait rather than fail immediately on lock)
      // Validate as safe integer to prevent PRAGMA injection
      const busyTimeout = Math.max(0, Math.trunc(options?.busyTimeout ?? DEFAULT_BUSY_TIMEOUT_MS));
      if (!Number.isFinite(busyTimeout)) {
        db.close();
        return Err(createError(ErrorCode.DB_CONNECTION_FAILED, "Invalid busy_timeout value"));
      }
      db.exec(`PRAGMA busy_timeout=${busyTimeout}`);

      // Enable foreign keys
      db.exec("PRAGMA foreign_keys=ON");

      // Securely delete data -- overwrite freed pages with zeros to prevent
      // recovery of sensitive information from the database file.
      db.exec("PRAGMA secure_delete=ON");

      // Enable incremental auto-vacuum so the database file can shrink
      // when data is deleted, preventing unbounded file growth.
      // NOTE: auto_vacuum mode can only be changed before any tables are created.
      // On existing databases, check the current mode and log a warning if mismatched.
      const currentAutoVacuum = db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | null;
      const currentMode = currentAutoVacuum?.auto_vacuum ?? 0;
      if (currentMode !== 2) {
        // Attempt to set it (succeeds only on fresh databases with no tables)
        db.exec("PRAGMA auto_vacuum=INCREMENTAL");
        const afterSet = db.query("PRAGMA auto_vacuum").get() as { auto_vacuum: number } | null;
        if ((afterSet?.auto_vacuum ?? 0) !== 2) {
          if (typeof console !== "undefined") {
            console.warn(
              `[eidolon] auto_vacuum=INCREMENTAL could not be set on "${path}" (current mode: ${currentMode}). ` +
                "Run VACUUM to apply on an existing database.",
            );
          }
        }
      }

      // Set WAL autocheckpoint to prevent unbounded WAL growth
      if (options?.walMode !== false) {
        db.exec(`PRAGMA wal_autocheckpoint=${WAL_AUTOCHECKPOINT_PAGES}`);
      }
    } catch (pragmaErr) {
      try {
        db.close();
      } catch {
        /* best-effort cleanup */
      }
      return Err(createError(ErrorCode.DB_CONNECTION_FAILED, "Failed to configure database PRAGMAs", pragmaErr));
    }

    // Restrict database file permissions to owner-only (skip for :memory:)
    if (path !== ":memory:") {
      try {
        chmodSync(path, DB_FILE_PERMISSIONS);
        // Also restrict WAL and SHM companion files if they exist
        const walPath = `${path}-wal`;
        const shmPath = `${path}-shm`;
        if (existsSync(walPath)) chmodSync(walPath, DB_FILE_PERMISSIONS);
        if (existsSync(shmPath)) chmodSync(shmPath, DB_FILE_PERMISSIONS);
      } catch {
        // Non-fatal: permissions may fail on some filesystems (e.g. FAT32)
      }
    }

    return Ok(db);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_CONNECTION_FAILED, "Failed to open database", cause));
  }
}
