import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.js";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.js";
import { createLogger } from "../../logging/logger.js";
import { SessionManager } from "../session.js";

const logger = createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 10, maxFiles: 1 });

describe("SessionManager", () => {
  let db: Database;
  let manager: SessionManager;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger);
    manager = new SessionManager(db, logger);
  });

  test("create() inserts session and returns SessionInfo", () => {
    const result = manager.create("main", "claude-123");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.type).toBe("main");
    expect(result.value.status).toBe("running");
    expect(result.value.tokensUsed).toBe(0);
    expect(result.value.claudeSessionId).toBe("claude-123");
    expect(result.value.id).toBeDefined();
  });

  test("updateStatus() changes status correctly", () => {
    const createResult = manager.create("task");
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const updateResult = manager.updateStatus(createResult.value.id, "completed");
    expect(updateResult.ok).toBe(true);

    const getResult = manager.get(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value?.status).toBe("completed");
  });

  test("addTokens() increments tokens and cost", () => {
    const createResult = manager.create("main");
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    manager.addTokens(createResult.value.id, 500, 0.01);
    manager.addTokens(createResult.value.id, 300, 0.005);

    const getResult = manager.get(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value?.tokensUsed).toBe(800);
  });

  test("get() returns session by ID, null for missing", () => {
    const createResult = manager.create("learning");
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const found = manager.get(createResult.value.id);
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value).not.toBeNull();
    expect(found.value?.type).toBe("learning");

    const missing = manager.get("nonexistent-id");
    expect(missing.ok).toBe(true);
    if (!missing.ok) return;
    expect(missing.value).toBeNull();
  });

  test("listActive() returns only running sessions", () => {
    manager.create("main");
    manager.create("task");
    const completedResult = manager.create("learning");
    expect(completedResult.ok).toBe(true);
    if (!completedResult.ok) return;
    manager.updateStatus(completedResult.value.id, "completed");

    const activeResult = manager.listActive();
    expect(activeResult.ok).toBe(true);
    if (!activeResult.ok) return;
    expect(activeResult.value.length).toBe(2);
    for (const session of activeResult.value) {
      expect(session.status).toBe("running");
    }
  });

  test("countByType() counts correctly", () => {
    manager.create("task");
    manager.create("task");
    manager.create("main");
    expect(manager.countByType("task")).toBe(2);
    expect(manager.countByType("main")).toBe(1);
    expect(manager.countByType("dream")).toBe(0);
  });
});
