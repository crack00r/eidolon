/**
 * P1-43: Backup/restore cycle verification.
 *
 * Tests the full backup lifecycle:
 * - Create backup, verify files exist with correct structure
 * - List backups in correct order (newest first)
 * - Prune old backups by age
 * - Encrypted backups: create, decrypt, verify content matches
 * - deleteAllBackups for GDPR forget cascade
 * - Edge cases: no backup dir, invalid keepDays, path validation
 *
 * Uses real temp directories and real SQLite databases (not in-memory)
 * because BackupManager uses VACUUM INTO which requires file-based DBs.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseConfig } from "@eidolon/protocol";
import { DatabaseManager } from "../../database/manager.ts";
import type { Logger } from "../../logging/logger.ts";
import { BackupManager } from "../manager.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

const logger = createSilentLogger();
const tempDirs: string[] = [];
const managers: DatabaseManager[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "eidolon-backup-cycle-"));
  tempDirs.push(dir);
  return dir;
}

function makeConfig(dir: string, backupPath?: string): DatabaseConfig {
  return {
    directory: dir,
    walMode: true,
    backupSchedule: "0 3 * * *",
    ...(backupPath !== undefined ? { backupPath } : {}),
  };
}

function setup(opts?: { backupPath?: string; encryptionKey?: Buffer }): {
  dbManager: DatabaseManager;
  backupMgr: BackupManager;
  dir: string;
  backupDir: string;
} {
  const dir = makeTempDir();
  const backupDir = opts?.backupPath ?? join(dir, "backups");
  const config = makeConfig(dir, opts?.backupPath);
  const dbManager = new DatabaseManager(config, logger);
  managers.push(dbManager);
  dbManager.initialize();
  const backupMgr = new BackupManager(dbManager, config, logger, opts?.encryptionKey);
  return { dbManager, backupMgr, dir, backupDir };
}

function cleanup(): void {
  for (const mgr of managers) {
    try {
      mgr.close();
    } catch {
      // already closed
    }
  }
  managers.length = 0;

  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
}

// ---------------------------------------------------------------------------
// Tests: Basic backup cycle
// ---------------------------------------------------------------------------

describe("BackupManager -- full backup cycle", () => {
  afterEach(cleanup);

  test("runBackup creates a timestamped directory with all 3 database files", () => {
    const { backupMgr, backupDir } = setup();

    const result = backupMgr.runBackup();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const timestamp = result.value;
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);

    const backupPath = join(backupDir, timestamp);
    expect(existsSync(backupPath)).toBe(true);
    expect(existsSync(join(backupPath, "memory.db"))).toBe(true);
    expect(existsSync(join(backupPath, "operational.db"))).toBe(true);
    expect(existsSync(join(backupPath, "audit.db"))).toBe(true);
  });

  test("backup files are valid SQLite databases", () => {
    const { backupMgr, backupDir } = setup();

    const result = backupMgr.runBackup();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const backupPath = join(backupDir, result.value);

    // Open the backed-up memory.db and verify it has the expected tables
    const memDb = new Database(join(backupPath, "memory.db"), { readonly: true });
    const tables = memDb
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("memory_edges");
    expect(tableNames).toContain("kg_entities");
    memDb.close();

    // Open the backed-up operational.db
    const opDb = new Database(join(backupPath, "operational.db"), { readonly: true });
    const opTables = opDb
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const opTableNames = opTables.map((t) => t.name);

    expect(opTableNames).toContain("sessions");
    expect(opTableNames).toContain("events");
    opDb.close();
  });

  test("backed-up database contains data written before backup", () => {
    const { dbManager, backupMgr, backupDir } = setup();

    // Insert data into the live database
    const now = Date.now();
    dbManager.memory.query(
      "INSERT INTO memories (id, type, layer, content, confidence, source, created_at, updated_at, accessed_at) VALUES (?, 'fact', 'long_term', ?, 0.9, 'test', ?, ?, ?)",
    ).run("test-mem-1", "backup cycle test data", now, now, now);

    // Create backup
    const result = backupMgr.runBackup();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Read from backup
    const backupPath = join(backupDir, result.value);
    const backupDb = new Database(join(backupPath, "memory.db"), { readonly: true });
    const row = backupDb.query("SELECT content FROM memories WHERE id = ?").get("test-mem-1") as {
      content: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.content).toBe("backup cycle test data");
    backupDb.close();
  });
});

// ---------------------------------------------------------------------------
// Tests: Listing backups
// ---------------------------------------------------------------------------

describe("BackupManager -- listing backups", () => {
  afterEach(cleanup);

  test("listBackups returns empty array when no backups exist", () => {
    const { backupMgr } = setup();

    const result = backupMgr.listBackups();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("listBackups returns backups sorted newest first", () => {
    const backupDir = makeTempDir();
    const { backupMgr } = setup({ backupPath: backupDir });

    // Create two fake backup directories with known timestamps
    const older = "2025-01-15_10-00-00";
    const newer = "2026-03-06_14-30-00";

    mkdirSync(join(backupDir, older), { recursive: true });
    mkdirSync(join(backupDir, newer), { recursive: true });

    const result = backupMgr.listBackups();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]).toBe(newer);
      expect(result.value[1]).toBe(older);
    }
  });

  test("listBackups ignores non-backup directories", () => {
    const backupDir = makeTempDir();
    const { backupMgr } = setup({ backupPath: backupDir });

    // Create one valid backup dir and one non-matching dir
    mkdirSync(join(backupDir, "2026-03-06_14-30-00"), { recursive: true });
    mkdirSync(join(backupDir, "not-a-backup"), { recursive: true });
    writeFileSync(join(backupDir, "random-file.txt"), "nope");

    const result = backupMgr.listBackups();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toBe("2026-03-06_14-30-00");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Pruning old backups
// ---------------------------------------------------------------------------

describe("BackupManager -- pruning old backups", () => {
  afterEach(cleanup);

  test("pruneOldBackups removes backups older than keepDays", () => {
    const backupDir = makeTempDir();
    const { backupMgr } = setup({ backupPath: backupDir });

    // Create an old backup directory
    const oldDir = join(backupDir, "2020-06-15_03-00-00");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "memory.db"), "placeholder");
    const oldDate = new Date("2020-06-15T03:00:00Z");
    utimesSync(oldDir, oldDate, oldDate);

    // Create a fresh backup
    backupMgr.runBackup();

    // Before prune: 2 backups
    const beforeResult = backupMgr.listBackups();
    expect(beforeResult.ok).toBe(true);
    if (beforeResult.ok) {
      expect(beforeResult.value).toHaveLength(2);
    }

    // Prune backups older than 7 days
    const pruneResult = backupMgr.pruneOldBackups(7);
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(1);
    }

    // After prune: only the fresh backup remains
    const afterResult = backupMgr.listBackups();
    expect(afterResult.ok).toBe(true);
    if (afterResult.ok) {
      expect(afterResult.value).toHaveLength(1);
    }

    // Old directory is gone
    expect(existsSync(oldDir)).toBe(false);
  });

  test("pruneOldBackups with keepDays=0 removes all backups", () => {
    const backupDir = makeTempDir();
    const { backupMgr } = setup({ backupPath: backupDir });

    // Create a fake backup with old mtime
    const dir = join(backupDir, "2026-03-06_10-00-00");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memory.db"), "data");
    const pastDate = new Date(Date.now() - 86_400_000); // 1 day ago
    utimesSync(dir, pastDate, pastDate);

    const result = backupMgr.pruneOldBackups(0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1);
    }
  });

  test("pruneOldBackups rejects negative keepDays", () => {
    const { backupMgr } = setup();

    const result = backupMgr.pruneOldBackups(-1);
    expect(result.ok).toBe(false);
  });

  test("pruneOldBackups rejects NaN keepDays", () => {
    const { backupMgr } = setup();

    const result = backupMgr.pruneOldBackups(Number.NaN);
    expect(result.ok).toBe(false);
  });

  test("pruneOldBackups returns 0 when no backup directory exists", () => {
    const dir = makeTempDir();
    const nonExistentBackupPath = join(dir, "does-not-exist");
    const config = makeConfig(dir, nonExistentBackupPath);
    const dbManager = new DatabaseManager(config, logger);
    managers.push(dbManager);
    dbManager.initialize();
    const backupMgr = new BackupManager(dbManager, config, logger);

    const result = backupMgr.pruneOldBackups(30);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: deleteAllBackups (GDPR forget)
// ---------------------------------------------------------------------------

describe("BackupManager -- deleteAllBackups (GDPR forget)", () => {
  afterEach(cleanup);

  test("deleteAllBackups removes all backup directories", () => {
    const backupDir = makeTempDir();
    const { backupMgr } = setup({ backupPath: backupDir });

    // Create multiple fake backups
    mkdirSync(join(backupDir, "2026-01-01_00-00-00"), { recursive: true });
    mkdirSync(join(backupDir, "2026-02-01_00-00-00"), { recursive: true });
    mkdirSync(join(backupDir, "2026-03-01_00-00-00"), { recursive: true });

    const result = backupMgr.deleteAllBackups();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(3);
    }

    // Verify all are gone
    const listResult = backupMgr.listBackups();
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value).toHaveLength(0);
    }
  });

  test("deleteAllBackups returns 0 when no backups exist", () => {
    const { backupMgr } = setup();

    const result = backupMgr.deleteAllBackups();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(0);
    }
  });

  test("deleteAllBackups preserves non-backup directories", () => {
    const backupDir = makeTempDir();
    const { backupMgr } = setup({ backupPath: backupDir });

    mkdirSync(join(backupDir, "2026-01-01_00-00-00"), { recursive: true });
    mkdirSync(join(backupDir, "custom-dir"), { recursive: true });

    const result = backupMgr.deleteAllBackups();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(1);
    }

    // Non-backup directory still exists
    expect(existsSync(join(backupDir, "custom-dir"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests: Encrypted backups
// ---------------------------------------------------------------------------

describe("BackupManager -- encrypted backups", () => {
  afterEach(cleanup);

  test("backup with encryption key creates .enc files instead of plain .db files", () => {
    const encryptionKey = randomBytes(32);
    const { backupMgr, backupDir } = setup({ encryptionKey });

    const result = backupMgr.runBackup();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const backupPath = join(backupDir, result.value);

    // Plain .db files should NOT exist (replaced by .enc)
    expect(existsSync(join(backupPath, "memory.db"))).toBe(false);
    expect(existsSync(join(backupPath, "operational.db"))).toBe(false);
    expect(existsSync(join(backupPath, "audit.db"))).toBe(false);

    // Encrypted files should exist
    expect(existsSync(join(backupPath, "memory.db.enc"))).toBe(true);
    expect(existsSync(join(backupPath, "operational.db.enc"))).toBe(true);
    expect(existsSync(join(backupPath, "audit.db.enc"))).toBe(true);
  });

  test("encrypted backup can be decrypted back to valid SQLite data", () => {
    const encryptionKey = randomBytes(32);
    const { dbManager, backupMgr, backupDir } = setup({ encryptionKey });

    // Insert test data
    const now = Date.now();
    dbManager.memory.query(
      "INSERT INTO memories (id, type, layer, content, confidence, source, created_at, updated_at, accessed_at) VALUES (?, 'fact', 'long_term', ?, 0.9, 'test', ?, ?, ?)",
    ).run("enc-test-1", "encrypted backup roundtrip", now, now, now);

    // Create encrypted backup
    const result = backupMgr.runBackup();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const backupPath = join(backupDir, result.value);
    const encPath = join(backupPath, "memory.db.enc");

    // Decrypt
    const decryptResult = backupMgr.decryptBackupFile(encPath);
    expect(decryptResult.ok).toBe(true);
    if (!decryptResult.ok) return;

    // Write decrypted content to a temp file and open as SQLite DB
    const decryptedDbPath = join(makeTempDir(), "decrypted-memory.db");
    writeFileSync(decryptedDbPath, decryptResult.value);

    const decryptedDb = new Database(decryptedDbPath, { readonly: true });
    const row = decryptedDb.query("SELECT content FROM memories WHERE id = ?").get("enc-test-1") as {
      content: string;
    } | null;

    expect(row).not.toBeNull();
    expect(row?.content).toBe("encrypted backup roundtrip");
    decryptedDb.close();
  });

  test("decryptBackupFile fails without encryption key", () => {
    // Create backup manager WITHOUT encryption key
    const { backupMgr } = setup();

    const result = backupMgr.decryptBackupFile("/nonexistent/path.enc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("No encryption key");
    }
  });

  test("decryptBackupFile fails with wrong key", () => {
    const encryptionKey = randomBytes(32);
    const { backupMgr, backupDir } = setup({ encryptionKey });

    // Create encrypted backup
    const backupResult = backupMgr.runBackup();
    expect(backupResult.ok).toBe(true);
    if (!backupResult.ok) return;

    const encPath = join(backupDir, backupResult.value, "memory.db.enc");

    // Try to decrypt with a different key
    const wrongKey = randomBytes(32);
    const dir = makeTempDir();
    const wrongConfig = makeConfig(dir);
    const wrongDbManager = new DatabaseManager(wrongConfig, logger);
    managers.push(wrongDbManager);
    wrongDbManager.initialize();
    const wrongMgr = new BackupManager(wrongDbManager, wrongConfig, logger, wrongKey);

    const result = wrongMgr.decryptBackupFile(encPath);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: Full backup-prune-verify cycle
// ---------------------------------------------------------------------------

describe("BackupManager -- end-to-end cycle", () => {
  afterEach(cleanup);

  test("full cycle: backup, insert more data, backup again, prune first, verify second survives", () => {
    const backupDir = makeTempDir();
    const { dbManager, backupMgr } = setup({ backupPath: backupDir });
    const now = Date.now();

    // Step 1: Insert initial data and back up
    dbManager.memory.query(
      "INSERT INTO memories (id, type, layer, content, confidence, source, created_at, updated_at, accessed_at) VALUES (?, 'fact', 'long_term', ?, 0.9, 'test', ?, ?, ?)",
    ).run("cycle-1", "first backup data", now, now, now);

    const first = backupMgr.runBackup();
    expect(first.ok).toBe(true);

    // Step 2: Rename the first backup so the second gets a unique timestamp dir
    // (both backups happen within the same second, so formatTimestamp() would collide)
    if (first.ok) {
      const firstDir = join(backupDir, first.value);
      const renamedDir = join(backupDir, "2020-01-01_00-00-00");
      renameSync(firstDir, renamedDir);
      const oldDate = new Date(Date.now() - 10 * 86_400_000); // 10 days ago
      utimesSync(renamedDir, oldDate, oldDate);
    }

    // Step 3: Insert more data and back up again
    dbManager.memory.query(
      "INSERT INTO memories (id, type, layer, content, confidence, source, created_at, updated_at, accessed_at) VALUES (?, 'fact', 'long_term', ?, 0.9, 'test', ?, ?, ?)",
    ).run("cycle-2", "second backup data", now, now, now);

    const second = backupMgr.runBackup();
    expect(second.ok).toBe(true);

    // Step 4: We should have 2 backups
    const listBefore = backupMgr.listBackups();
    expect(listBefore.ok).toBe(true);
    if (listBefore.ok) {
      expect(listBefore.value).toHaveLength(2);
    }

    // Step 5: Prune backups older than 3 days (removes the first)
    const pruneResult = backupMgr.pruneOldBackups(3);
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(1);
    }

    // Step 6: Only the second backup survives
    const listAfter = backupMgr.listBackups();
    expect(listAfter.ok).toBe(true);
    if (listAfter.ok) {
      expect(listAfter.value).toHaveLength(1);
    }

    // Step 7: Verify the surviving backup has both memories
    if (second.ok) {
      const survivalPath = join(backupDir, second.value, "memory.db");
      const backupDb = new Database(survivalPath, { readonly: true });
      const count = (backupDb.query("SELECT COUNT(*) as c FROM memories").get() as { c: number }).c;
      expect(count).toBe(2);
      backupDb.close();
    }
  });

  test("GDPR forget: deleteAllBackups wipes everything after multiple backups", () => {
    const backupDir = makeTempDir();
    const { backupMgr } = setup({ backupPath: backupDir });

    // Create 3 backups
    backupMgr.runBackup();
    // Create additional fake dirs to simulate multiple backup cycles
    mkdirSync(join(backupDir, "2025-12-01_00-00-00"), { recursive: true });
    mkdirSync(join(backupDir, "2025-11-01_00-00-00"), { recursive: true });

    const beforeList = backupMgr.listBackups();
    expect(beforeList.ok).toBe(true);
    if (beforeList.ok) {
      expect(beforeList.value.length).toBeGreaterThanOrEqual(3);
    }

    // GDPR forget
    const deleteResult = backupMgr.deleteAllBackups();
    expect(deleteResult.ok).toBe(true);
    if (deleteResult.ok) {
      expect(deleteResult.value).toBeGreaterThanOrEqual(3);
    }

    // Verify nothing remains
    const afterList = backupMgr.listBackups();
    expect(afterList.ok).toBe(true);
    if (afterList.ok) {
      expect(afterList.value).toHaveLength(0);
    }
  });
});
