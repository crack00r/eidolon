/**
 * Tests for UserManager -- CRUD operations on the users table.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { UserManager } from "../manager.ts";
import { DEFAULT_USER_ID } from "../schema.ts";

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

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, createSilentLogger());
  if (!result.ok) {
    throw new Error(`Migration failed: ${result.error.message}`);
  }
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserManager", () => {
  let db: Database;
  let manager: UserManager;

  beforeEach(() => {
    db = createTestDb();
    manager = new UserManager(db, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  describe("create", () => {
    test("creates a user with auto-generated ID", () => {
      const result = manager.create({ name: "Alice" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("Alice");
      expect(result.value.id).toBeTruthy();
      expect(result.value.channelMappings).toEqual([]);
      expect(result.value.createdAt).toBeGreaterThan(0);
    });

    test("creates a user with specified ID", () => {
      const result = manager.create({ id: "custom-id", name: "Bob" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe("custom-id");
    });

    test("creates a user with channel mappings", () => {
      const result = manager.create({
        name: "Charlie",
        channelMappings: [{ channelType: "telegram", externalUserId: "12345" }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.channelMappings).toHaveLength(1);
      expect(result.value.channelMappings[0]?.channelType).toBe("telegram");
    });

    test("creates a user with preferences", () => {
      const result = manager.create({
        name: "Diana",
        preferences: { language: "de", timezone: "Europe/Berlin" },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.preferences.language).toBe("de");
      expect(result.value.preferences.timezone).toBe("Europe/Berlin");
    });

    test("fails on duplicate ID", () => {
      manager.create({ id: "dup", name: "First" });
      const result = manager.create({ id: "dup", name: "Second" });
      expect(result.ok).toBe(false);
    });
  });

  describe("get", () => {
    test("returns user by ID", () => {
      manager.create({ id: "u1", name: "Alice" });
      const result = manager.get("u1");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.name).toBe("Alice");
    });

    test("returns null for non-existent user", () => {
      const result = manager.get("nonexistent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe("update", () => {
    test("updates user name", () => {
      manager.create({ id: "u1", name: "Alice" });
      const result = manager.update("u1", { name: "Alice Updated" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("Alice Updated");
    });

    test("updates channel mappings", () => {
      manager.create({ id: "u1", name: "Alice" });
      const result = manager.update("u1", {
        channelMappings: [{ channelType: "discord", externalUserId: "disc123" }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.channelMappings).toHaveLength(1);
    });

    test("fails for non-existent user", () => {
      const result = manager.update("nonexistent", { name: "Ghost" });
      expect(result.ok).toBe(false);
    });
  });

  describe("delete", () => {
    test("deletes a user", () => {
      manager.create({ id: "u1", name: "Alice" });
      const result = manager.delete("u1");
      expect(result.ok).toBe(true);

      const getResult = manager.get("u1");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toBeNull();
    });

    test("cannot delete default user", () => {
      manager.ensureDefaultUser();
      const result = manager.delete(DEFAULT_USER_ID);
      expect(result.ok).toBe(false);
    });

    test("fails for non-existent user", () => {
      const result = manager.delete("nonexistent");
      expect(result.ok).toBe(false);
    });
  });

  describe("list", () => {
    test("lists all users", () => {
      manager.create({ id: "u1", name: "Alice" });
      manager.create({ id: "u2", name: "Bob" });
      const result = manager.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
    });

    test("returns empty array when no users", () => {
      const result = manager.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });
  });

  describe("ensureDefaultUser", () => {
    test("creates default user if not exists", () => {
      const result = manager.ensureDefaultUser();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe(DEFAULT_USER_ID);
      expect(result.value.name).toBe("Default User");
    });

    test("returns existing default user if already exists", () => {
      manager.ensureDefaultUser();
      const result = manager.ensureDefaultUser();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe(DEFAULT_USER_ID);
    });
  });

  describe("findByChannel", () => {
    test("finds user by channel mapping", () => {
      manager.create({
        id: "u1",
        name: "Alice",
        channelMappings: [{ channelType: "telegram", externalUserId: "12345" }],
      });
      const result = manager.findByChannel("telegram", "12345");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.id).toBe("u1");
    });

    test("returns null when no matching channel mapping", () => {
      manager.create({ id: "u1", name: "Alice" });
      const result = manager.findByChannel("telegram", "99999");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    test("distinguishes channel types", () => {
      manager.create({
        id: "u1",
        name: "Alice",
        channelMappings: [{ channelType: "telegram", externalUserId: "12345" }],
      });
      const result = manager.findByChannel("discord", "12345");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  describe("count", () => {
    test("counts users", () => {
      manager.create({ name: "Alice" });
      manager.create({ name: "Bob" });
      const result = manager.count();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(2);
    });
  });
});
