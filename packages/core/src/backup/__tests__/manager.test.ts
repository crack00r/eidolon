import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseConfig } from "@eidolon/protocol";
import { DatabaseManager } from "../../database/manager.ts";
import type { Logger } from "../../logging/logger.ts";
import { BackupManager } from "../manager.ts";

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

describe("BackupManager", () => {
  const logger = createSilentLogger();
  const tempDirs: string[] = [];
  const managers: DatabaseManager[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "eidolon-backup-test-"));
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

  function setup(backupPath?: string): {
    dbManager: DatabaseManager;
    backupMgr: BackupManager;
    dir: string;
    backupDir: string;
  } {
    const dir = makeTempDir();
    const backupDir = backupPath ?? join(dir, "backups");
    const config = makeConfig(dir, backupPath);
    const dbManager = new DatabaseManager(config, logger);
    managers.push(dbManager);
    dbManager.initialize();
    const backupMgr = new BackupManager(dbManager, config, logger);
    return { dbManager, backupMgr, dir, backupDir };
  }

  afterEach(() => {
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
  });

  test("backup creates timestamped directory with all 3 DB files", () => {
    const { backupMgr, backupDir } = setup();

    const result = backupMgr.runBackup();
    expect(result.ok).toBe(true);

    if (result.ok) {
      const backupPath = join(backupDir, result.value);
      expect(existsSync(backupPath)).toBe(true);
      expect(existsSync(join(backupPath, "memory.db"))).toBe(true);
      expect(existsSync(join(backupPath, "operational.db"))).toBe(true);
      expect(existsSync(join(backupPath, "audit.db"))).toBe(true);
    }
  });

  test("listBackups returns correct directories", () => {
    const { backupMgr } = setup();

    backupMgr.runBackup();

    const listResult = backupMgr.listBackups();
    expect(listResult.ok).toBe(true);
    if (listResult.ok) {
      expect(listResult.value).toHaveLength(1);
      expect(listResult.value[0]).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/);
    }
  });

  test("pruneOldBackups removes old backups", () => {
    const backupDir = makeTempDir();
    const { backupMgr } = setup(backupDir);

    // Create a fake old backup directory
    const oldDir = join(backupDir, "2020-01-01_00-00-00");
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, "memory.db"), "fake");

    // Set mtime to far in the past
    const oldDate = new Date("2020-01-01T00:00:00Z");
    utimesSync(oldDir, oldDate, oldDate);

    // Create a fresh backup
    backupMgr.runBackup();

    const beforeList = backupMgr.listBackups();
    expect(beforeList.ok).toBe(true);
    if (beforeList.ok) {
      expect(beforeList.value).toHaveLength(2);
    }

    // Prune backups older than 1 day
    const pruneResult = backupMgr.pruneOldBackups(1);
    expect(pruneResult.ok).toBe(true);
    if (pruneResult.ok) {
      expect(pruneResult.value).toBe(1);
    }

    const afterList = backupMgr.listBackups();
    expect(afterList.ok).toBe(true);
    if (afterList.ok) {
      expect(afterList.value).toHaveLength(1);
    }
  });
});
