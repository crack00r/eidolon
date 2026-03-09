/**
 * Backup manager for the 3-database split architecture.
 *
 * Creates timestamped backups of memory.db, operational.db, and audit.db.
 * Supports listing, pruning old backups, encryption, and full deletion.
 *
 * PRIV-003: Backups can optionally be encrypted with master key (AES-256-GCM).
 * When `privacy forget` is executed, all backups must be deleted.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
import type { DatabaseManager } from "../database/manager.ts";
import type { Logger } from "../logging/logger.ts";

/** Milliseconds in one day, used for backup age calculations. */
const MS_PER_DAY = 86_400_000;

/** Minimum allowed value for keepDays in pruneOldBackups. */
const MIN_KEEP_DAYS = 0;

/** Restrictive file permissions for backup files (owner read/write only). */
const BACKUP_FILE_PERMISSIONS = 0o600;

/** Restrictive directory permissions for backup directories (owner only). */
const BACKUP_DIR_PERMISSIONS = 0o700;

/** AES-256-GCM encryption parameters. */
const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ENCRYPTED_SUFFIX = ".enc";

/** Domain separation tag for deriving a backup-specific key from the master key. */
const BACKUP_KEY_DOMAIN = "eidolon-backup-v1";

/**
 * Characters forbidden in backup paths to prevent SQL injection via VACUUM INTO.
 * Single quotes are the primary injection vector, but we also reject other
 * characters that have no legitimate use in backup file paths.
 */
const FORBIDDEN_PATH_CHARS = /['\0\\;]/;

/**
 * Validate and canonicalize a backup file path.
 * Ensures the path is under the allowed backup root and contains no
 * SQL injection characters. Returns the canonical path or an error.
 */
function validateBackupPath(filePath: string, backupRoot: string): Result<string, EidolonError> {
  const canonical = resolve(filePath);
  const canonicalRoot = resolve(backupRoot);

  // Ensure the backup path is under the allowed backup directory
  if (!canonical.startsWith(`${canonicalRoot}/`) && canonical !== canonicalRoot) {
    return Err(
      createError(
        ErrorCode.INVALID_INPUT,
        `Backup path escapes allowed directory: ${canonical} is not under ${canonicalRoot}`,
      ),
    );
  }

  // Reject paths with SQL injection characters
  if (FORBIDDEN_PATH_CHARS.test(canonical)) {
    return Err(
      createError(ErrorCode.INVALID_INPUT, "Backup path contains forbidden characters (potential SQL injection)"),
    );
  }

  return Ok(canonical);
}

/** Format a date as YYYY-MM-DD_HH-mm-ss. */
function formatTimestamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

/** Check if a string matches the backup directory name pattern. */
function isBackupDir(name: string): boolean {
  return /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(name);
}

/**
 * Derive a backup-specific key from the master key using HMAC-SHA256.
 * This provides domain separation so the master key is never used directly.
 */
function deriveBackupKey(masterKey: Buffer): Buffer {
  return createHmac("sha256", masterKey).update(BACKUP_KEY_DOMAIN).digest();
}

/**
 * Encrypt a file in-place using AES-256-GCM.
 * Writes: [12-byte IV] [16-byte auth tag] [ciphertext]
 */
function encryptFile(filePath: string, key: Buffer): void {
  const plaintext = readFileSync(filePath);
  try {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const output = Buffer.concat([iv, authTag, encrypted]);
    const encPath = `${filePath}${ENCRYPTED_SUFFIX}`;
    const tmpPath = `${encPath}.tmp`;

    // Atomic write: write to temp file, then rename (atomic on same filesystem)
    writeFileSync(tmpPath, output);
    chmodSync(tmpPath, BACKUP_FILE_PERMISSIONS);
    renameSync(tmpPath, encPath);

    // Remove the unencrypted original
    rmSync(filePath, { force: true });
  } finally {
    // Zeroize plaintext buffer to prevent sensitive data lingering in memory
    plaintext.fill(0);
  }
}

/**
 * Decrypt an encrypted backup file.
 * Expects: [12-byte IV] [16-byte auth tag] [ciphertext]
 */
function decryptFile(encPath: string, key: Buffer): Buffer {
  const data = readFileSync(encPath);
  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export class BackupManager {
  private readonly dbManager: DatabaseManager;
  private readonly config: DatabaseConfig;
  private readonly logger: Logger;
  private encryptionKey?: Buffer;

  constructor(dbManager: DatabaseManager, config: DatabaseConfig, logger: Logger, encryptionKey?: Buffer) {
    this.dbManager = dbManager;
    this.config = config;
    this.logger = logger.child("backup");
    this.encryptionKey = encryptionKey ? deriveBackupKey(encryptionKey) : undefined;
  }

  /** Zeroize the encryption key material and release it. */
  dispose(): void {
    if (this.encryptionKey) {
      this.encryptionKey.fill(0);
      this.encryptionKey = undefined;
      this.logger.debug("dispose", "Encryption key zeroized");
    }
  }

  /** Resolve the backup root path from config, falling back to a 'backups' subdirectory. */
  private getBackupRoot(): string {
    return this.config.backupPath ?? join(this.config.directory, "backups");
  }

  /** Run backup of all 3 databases to a timestamped directory. */
  runBackup(): Result<string, EidolonError> {
    const backupRoot = this.getBackupRoot();
    const timestamp = formatTimestamp(new Date());
    const backupDir = join(backupRoot, timestamp);

    try {
      mkdirSync(backupDir, { recursive: true });

      // Restrict backup directory permissions to owner-only
      try {
        chmodSync(backupDir, BACKUP_DIR_PERMISSIONS);
      } catch {
        // Non-fatal: may fail on some filesystems
      }

      // Use VACUUM INTO for atomic, consistent backup (no WAL/checkpoint issues)
      const databases: ReadonlyArray<readonly [string, { exec: (sql: string) => void }]> = [
        [MEMORY_DB_FILENAME, this.dbManager.memory],
        [OPERATIONAL_DB_FILENAME, this.dbManager.operational],
        [AUDIT_DB_FILENAME, this.dbManager.audit],
      ];

      for (const [dbFile, db] of databases) {
        const backupPath = join(backupDir, dbFile);

        // Validate path to prevent SQL injection via VACUUM INTO
        const pathResult = validateBackupPath(backupPath, backupRoot);
        if (!pathResult.ok) {
          return pathResult;
        }
        const safePath = pathResult.value;

        // SEC-H6: VACUUM INTO requires a string literal path and does NOT support
        // parameterized queries (? placeholders). The path is safe because:
        //   1. validateBackupPath() canonicalizes it via resolve()
        //   2. validateBackupPath() rejects paths containing ' \ ; NUL (FORBIDDEN_PATH_CHARS)
        //   3. validateBackupPath() ensures the path stays under backupRoot
        // This is SQLite's exec(), not shell exec() -- no command injection risk.
        db.exec(`VACUUM INTO '${safePath}'`);

        // Restrict backup file permissions to owner-only
        try {
          chmodSync(backupPath, BACKUP_FILE_PERMISSIONS);
        } catch {
          // Non-fatal: may fail on some filesystems
        }

        // PRIV-003: Encrypt backup if encryption key is available
        if (this.encryptionKey) {
          try {
            encryptFile(backupPath, this.encryptionKey);
            this.logger.debug("backup", `Encrypted backup file: ${dbFile}`);
          } catch (encErr: unknown) {
            // Clean up and fail -- partial encrypted backups are dangerous
            try {
              rmSync(backupDir, { recursive: true, force: true });
            } catch {
              // Best-effort cleanup
            }
            return Err(createError(ErrorCode.DB_QUERY_FAILED, `Backup encryption failed for ${dbFile}`, encErr));
          }
        }
      }

      this.logger.info("backup", `Backup created: ${timestamp}`, {
        path: backupDir,
        encrypted: !!this.encryptionKey,
      });
      return Ok(timestamp);
    } catch (err: unknown) {
      // Clean up partial backup directory on failure
      try {
        if (existsSync(backupDir)) {
          rmSync(backupDir, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup -- log but do not mask original error
        this.logger.warn("backup", "Failed to clean up partial backup directory");
      }
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Backup failed", err));
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
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list backups", err));
    }
  }

  /** Remove backups older than keepDays. Returns count of removed backups. */
  pruneOldBackups(keepDays: number): Result<number, EidolonError> {
    // Validate keepDays to prevent unexpected behavior with negative or non-finite values
    if (!Number.isFinite(keepDays) || keepDays < MIN_KEEP_DAYS) {
      return Err(createError(ErrorCode.INVALID_INPUT, "Invalid keepDays value: must be a non-negative number"));
    }

    try {
      const backupRoot = this.getBackupRoot();

      if (!existsSync(backupRoot)) {
        return Ok(0);
      }

      const cutoff = Date.now() - keepDays * MS_PER_DAY;
      const entries = readdirSync(backupRoot, { withFileTypes: true });
      let count = 0;

      for (const entry of entries) {
        if (!entry.isDirectory() || !isBackupDir(entry.name)) {
          continue;
        }

        const dirPath = join(backupRoot, entry.name);
        const dirStat = statSync(dirPath);

        if (dirStat.mtimeMs < cutoff) {
          rmSync(dirPath, { recursive: true, force: true });
          count += 1;
          this.logger.debug("prune", `Removed old backup: ${entry.name}`);
        }
      }

      this.logger.info("prune", `Pruned ${count} old backup(s)`, { keepDays, removed: count });
      return Ok(count);
    } catch (err: unknown) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to prune backups", err));
    }
  }

  /**
   * PRIV-003: Delete ALL backup files.
   * Called during `privacy forget` to ensure no user data survives in backups.
   * Returns the count of deleted backup directories.
   */
  deleteAllBackups(): Result<number, EidolonError> {
    try {
      const backupRoot = this.getBackupRoot();

      if (!existsSync(backupRoot)) {
        return Ok(0);
      }

      const entries = readdirSync(backupRoot, { withFileTypes: true });
      let count = 0;

      for (const entry of entries) {
        if (!entry.isDirectory() || !isBackupDir(entry.name)) {
          continue;
        }

        const dirPath = join(backupRoot, entry.name);
        rmSync(dirPath, { recursive: true, force: true });
        count += 1;
        this.logger.debug("deleteAll", `Deleted backup: ${entry.name}`);
      }

      this.logger.info("deleteAll", `Deleted all ${count} backup(s) (GDPR forget cascade)`, {
        removed: count,
      });
      return Ok(count);
    } catch (err: unknown) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to delete all backups", err));
    }
  }

  /**
   * Decrypt a specific backup file (utility for restore operations).
   * Returns the decrypted file content as a Buffer.
   */
  decryptBackupFile(encryptedPath: string): Result<Buffer, EidolonError> {
    if (!this.encryptionKey) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "No encryption key available for decryption"));
    }

    try {
      const content = decryptFile(encryptedPath, this.encryptionKey);
      return Ok(content);
    } catch (err: unknown) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Backup decryption failed", err));
    }
  }
}
