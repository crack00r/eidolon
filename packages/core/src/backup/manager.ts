/**
 * Backup manager for the 3-database split architecture.
 *
 * Creates timestamped backups of memory.db, operational.db, and audit.db.
 * Supports listing and pruning old backups.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseConfig, EidolonError, Result } from "@eidolon/protocol";
import {
  AUDIT_DB_FILENAME,
  createError,
  Err,
  ErrorCode,
  MEMORY_DB_FILENAME,
  Ok,
  OPERATIONAL_DB_FILENAME,
} from "@eidolon/protocol";
import type { DatabaseManager } from "../database/manager.js";
import type { Logger } from "../logging/logger.js";

const DB_FILES = [MEMORY_DB_FILENAME, OPERATIONAL_DB_FILENAME, AUDIT_DB_FILENAME] as const;

/** Format a date as YYYY-MM-DD_HH-mm-ss. */
function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** Check if a string matches the backup directory name pattern. */
function isBackupDir(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name);
}

export class BackupManager {
  private readonly dbManager: DatabaseManager;
  private readonly config: DatabaseConfig;
  private readonly logger: Logger;

  constructor(dbManager: DatabaseManager, config: DatabaseConfig, logger: Logger) {
    this.dbManager = dbManager;
    this.config = config;
    this.logger = logger.child("backup");
  }

  /** Resolve the backup root path from config, falling back to a 'backups' subdirectory. */
  private getBackupRoot(): string {
    return this.config.backupPath ?? join(this.config.directory, "backups");
  }

  /** Run backup of all 3 databases to a timestamped directory. */
  runBackup(): Result<string, EidolonError> {
    try {
      const backupRoot = this.getBackupRoot();
      const timestamp = formatTimestamp(new Date());
      const backupDir = join(backupRoot, timestamp);

      mkdirSync(backupDir, { recursive: true });

      // Flush WAL before copying
      this.flushWal();

      for (const dbFile of DB_FILES) {
        const src = join(this.config.directory, dbFile);
        if (existsSync(src)) {
          copyFileSync(src, join(backupDir, dbFile));
        }
      }

      this.logger.info("backup", `Backup created: ${timestamp}`, { path: backupDir });
      return Ok(timestamp);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Backup failed: ${message}`, err));
    }
  }

  /** List all existing backups (directory names), sorted newest first. */
  listBackups(): Result<string[], EidolonError> {
    try {
      const backupRoot = this.getBackupRoot();

      if (!existsSync(backupRoot)) {
        return Ok([]);
      }

      const entries = readdirSync(backupRoot, { withFileTypes: true });
      const backups = entries
        .filter((entry) => entry.isDirectory() && isBackupDir(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse();

      return Ok(backups);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to list backups: ${message}`, err));
    }
  }

  /** Remove backups older than keepDays. Returns count of removed backups. */
  pruneOldBackups(keepDays: number): Result<number, EidolonError> {
    try {
      const backupRoot = this.getBackupRoot();

      if (!existsSync(backupRoot)) {
        return Ok(0);
      }

      const cutoff = Date.now() - keepDays * 86_400_000;
      const entries = readdirSync(backupRoot, { withFileTypes: true });
      const removed: number[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory() || !isBackupDir(entry.name)) {
          continue;
        }

        const dirPath = join(backupRoot, entry.name);
        const dirStat = statSync(dirPath);

        if (dirStat.mtimeMs < cutoff) {
          rmSync(dirPath, { recursive: true, force: true });
          removed.push(1);
          this.logger.debug("prune", `Removed old backup: ${entry.name}`);
        }
      }

      const count = removed.length;
      this.logger.info("prune", `Pruned ${count} old backup(s)`, { keepDays, removed: count });
      return Ok(count);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to prune backups: ${message}`, err));
    }
  }

  /** Flush WAL on all databases before file copy. */
  private flushWal(): void {
    try {
      this.dbManager.memory.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.dbManager.operational.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      this.dbManager.audit.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      this.logger.warn("backup", "WAL checkpoint failed (databases may not use WAL mode)");
    }
  }
}
