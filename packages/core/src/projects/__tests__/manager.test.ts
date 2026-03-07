/**
 * Tests for ProjectManager -- CRUD operations on in-memory SQLite.
 * Uses the eidolon repo itself as a read-only git repo for validation.
 * Note: All git operations are strictly read-only (no writes to the repo).
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Logger } from "../../logging/logger.ts";
import { ProjectManager } from "../manager.ts";
import { PROJECT_JOURNAL_TABLE_SQL, PROJECTS_TABLE_SQL } from "../schema.ts";

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

// Path to the eidolon repo itself (a valid git repo for read-only testing)
const EIDOLON_REPO = join(import.meta.dir, "../../../../..");

describe("ProjectManager", () => {
  const logger = createSilentLogger();
  let db: Database;
  let manager: ProjectManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new ProjectManager(db, logger);
  });

  test("ensureTables creates tables idempotently", () => {
    const result = manager.ensureTables();
    expect(result.ok).toBe(true);
  });

  test("create registers a project with valid git repo", async () => {
    const result = await manager.create({
      name: "eidolon",
      repoPath: EIDOLON_REPO,
      description: "AI Assistant",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("eidolon");
      expect(result.value.repoPath).toBe(EIDOLON_REPO);
      expect(result.value.description).toBe("AI Assistant");
      expect(result.value.lastSyncedAt).toBeNull();
      expect(result.value.id.length).toBeGreaterThan(0);
    }
  });

  test("create rejects non-git-repo path", async () => {
    const result = await manager.create({
      name: "bad-project",
      repoPath: "/tmp",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not a git repository");
    }
  });

  test("create rejects duplicate name", async () => {
    await manager.create({ name: "eidolon", repoPath: EIDOLON_REPO });
    const result = await manager.create({ name: "eidolon", repoPath: EIDOLON_REPO });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("already exists");
    }
  });

  test("create rejects invalid input", async () => {
    const result = await manager.create({
      name: "",
      repoPath: EIDOLON_REPO,
    });
    expect(result.ok).toBe(false);
  });

  test("get returns project by ID", async () => {
    const createResult = await manager.create({ name: "test", repoPath: EIDOLON_REPO });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const getResult = manager.get(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value?.name).toBe("test");
    }
  });

  test("get returns null for non-existent ID", () => {
    const result = manager.get("non-existent-id");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  test("getByName returns project by name", async () => {
    await manager.create({ name: "my-project", repoPath: EIDOLON_REPO });
    const result = manager.getByName("my-project");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value?.name).toBe("my-project");
    }
  });

  test("list returns all projects sorted by name", async () => {
    await manager.create({ name: "bravo", repoPath: EIDOLON_REPO });
    await manager.create({ name: "alpha", repoPath: EIDOLON_REPO });

    const result = manager.list();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      expect(result.value[0]?.name).toBe("alpha");
      expect(result.value[1]?.name).toBe("bravo");
    }
  });

  test("update modifies project fields", async () => {
    const createResult = await manager.create({ name: "proj", repoPath: EIDOLON_REPO });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const updateResult = manager.update(createResult.value.id, {
      description: "Updated desc",
    });
    expect(updateResult.ok).toBe(true);
    if (updateResult.ok) {
      expect(updateResult.value.description).toBe("Updated desc");
      expect(updateResult.value.updatedAt).toBeGreaterThanOrEqual(createResult.value.updatedAt);
    }
  });

  test("update returns error for non-existent project", () => {
    const result = manager.update("non-existent", { description: "x" });
    expect(result.ok).toBe(false);
  });

  test("delete removes project", async () => {
    const createResult = await manager.create({ name: "deleteme", repoPath: EIDOLON_REPO });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const deleteResult = manager.delete(createResult.value.id);
    expect(deleteResult.ok).toBe(true);

    const getResult = manager.get(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value).toBeNull();
    }
  });

  test("delete returns error for non-existent project", () => {
    const result = manager.delete("non-existent");
    expect(result.ok).toBe(false);
  });

  test("markSynced updates last_synced_at", async () => {
    const createResult = await manager.create({ name: "sync-test", repoPath: EIDOLON_REPO });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const syncResult = manager.markSynced(createResult.value.id);
    expect(syncResult.ok).toBe(true);

    const getResult = manager.get(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok && getResult.value) {
      expect(getResult.value.lastSyncedAt).not.toBeNull();
    }
  });

  test("getStatus returns live project status", async () => {
    const createResult = await manager.create({ name: "status-test", repoPath: EIDOLON_REPO });
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const statusResult = await manager.getStatus(createResult.value.id);
    expect(statusResult.ok).toBe(true);
    if (statusResult.ok) {
      expect(statusResult.value.project.name).toBe("status-test");
      expect(statusResult.value.currentBranch.length).toBeGreaterThan(0);
      expect(statusResult.value.branches.length).toBeGreaterThan(0);
      expect(statusResult.value.recentCommits.length).toBeGreaterThan(0);
    }
  });
});
