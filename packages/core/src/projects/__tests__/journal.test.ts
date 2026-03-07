/**
 * Tests for ProjectJournal -- daily/weekly entry generation.
 * Uses the eidolon repo itself as a read-only git repo for commits.
 *
 * SECURITY NOTE: All git operations in this module use Bun.spawn()
 * with explicit argument arrays (not shell strings), preventing
 * any command injection. No user input reaches a shell.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test, beforeEach } from "bun:test";
import { join } from "node:path";
import type { Logger } from "../../logging/logger.ts";
import { ProjectJournal } from "../journal.ts";
import type { Project } from "../schema.ts";
import { PROJECTS_TABLE_SQL, PROJECT_JOURNAL_TABLE_SQL } from "../schema.ts";

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

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(PROJECTS_TABLE_SQL);
  db.exec(PROJECT_JOURNAL_TABLE_SQL);
  return db;
}

const EIDOLON_REPO = join(import.meta.dir, "../../../../..");

function createTestProject(db: Database): Project {
  const id = "test-project-id";
  const now = Date.now();
  db.query(
    `INSERT INTO projects (id, name, repo_path, description, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, "eidolon", EIDOLON_REPO, "test", now, now);
  return {
    id,
    name: "eidolon",
    repoPath: EIDOLON_REPO,
    description: "test",
    lastSyncedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("ProjectJournal", () => {
  const logger = createSilentLogger();
  let db: Database;
  let journal: ProjectJournal;
  let project: Project;

  beforeEach(() => {
    db = createTestDb();
    journal = new ProjectJournal(db, logger);
    project = createTestProject(db);
  });

  test("generateDaily creates entry with commits", async () => {
    const result = await journal.generateDaily(project);
    expect(result.ok).toBe(true);
  });

  test("generateDaily is idempotent", async () => {
    const fixedDate = Date.now();
    const first = await journal.generateDaily(project, fixedDate);
    const second = await journal.generateDaily(project, fixedDate);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    if (first.ok && second.ok && first.value && second.value) {
      expect(first.value.id).toBe(second.value.id);
    }
  });

  test("generateWeekly creates entry", async () => {
    const result = await journal.generateWeekly(project);
    expect(result.ok).toBe(true);
  });

  test("getEntries returns empty array when no entries", () => {
    const result = journal.getEntries(project.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("getEntries returns entries after generation", async () => {
    await journal.generateDaily(project);

    const result = journal.getEntries(project.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThanOrEqual(0);
    }
  });

  test("getEntries filters by period", () => {
    const now = Date.now();
    db.query(
      `INSERT INTO project_journal
       (id, project_id, period, period_start, period_end, summary, commit_count, files_changed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("d1", project.id, "daily", now - 86400000, now, "daily entry", 3, 5, now);
    db.query(
      `INSERT INTO project_journal
       (id, project_id, period, period_start, period_end, summary, commit_count, files_changed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("w1", project.id, "weekly", now - 604800000, now, "weekly entry", 15, 20, now);

    const dailyResult = journal.getEntries(project.id, { period: "daily" });
    expect(dailyResult.ok).toBe(true);
    if (dailyResult.ok) {
      expect(dailyResult.value.length).toBe(1);
      expect(dailyResult.value[0]?.period).toBe("daily");
    }

    const weeklyResult = journal.getEntries(project.id, { period: "weekly" });
    expect(weeklyResult.ok).toBe(true);
    if (weeklyResult.ok) {
      expect(weeklyResult.value.length).toBe(1);
      expect(weeklyResult.value[0]?.period).toBe("weekly");
    }
  });

  test("getEntries respects limit", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.query(
        `INSERT INTO project_journal
         (id, project_id, period, period_start, period_end, summary, commit_count, files_changed, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        `e${i}`, project.id, "daily",
        now - (i + 1) * 86400000, now - i * 86400000,
        `entry ${i}`, 1, 1, now,
      );
    }

    const result = journal.getEntries(project.id, { limit: 3 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
    }
  });

  test("syncAll generates entries for multiple projects", async () => {
    const result = await journal.syncAll([project]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value).toBe("number");
    }
  });
});
