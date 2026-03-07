/**
 * Tests for ChannelResolver -- resolving external channel IDs to Eidolon users.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { ChannelResolver } from "../channel-resolver.ts";
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

describe("ChannelResolver", () => {
  let db: Database;
  let manager: UserManager;
  const logger = createSilentLogger();

  beforeEach(() => {
    db = createTestDb();
    manager = new UserManager(db, logger);
    manager.ensureDefaultUser();
  });

  afterEach(() => {
    db.close();
  });

  describe("single-user mode (multiUserEnabled=false)", () => {
    test("always returns default user", () => {
      const resolver = new ChannelResolver(manager, logger, {
        multiUserEnabled: false,
        autoCreateUsers: false,
      });

      const result = resolver.resolve({
        channelType: "telegram",
        externalUserId: "12345",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe(DEFAULT_USER_ID);
    });
  });

  describe("multi-user mode", () => {
    test("resolves existing user by channel mapping", () => {
      manager.create({
        id: "alice",
        name: "Alice",
        channelMappings: [{ channelType: "telegram", externalUserId: "12345" }],
      });

      const resolver = new ChannelResolver(manager, logger, {
        multiUserEnabled: true,
        autoCreateUsers: false,
      });

      const result = resolver.resolve({
        channelType: "telegram",
        externalUserId: "12345",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe("alice");
    });

    test("auto-creates user when enabled", () => {
      const resolver = new ChannelResolver(manager, logger, {
        multiUserEnabled: true,
        autoCreateUsers: true,
      });

      const result = resolver.resolve({
        channelType: "telegram",
        externalUserId: "99999",
        displayName: "New User",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("New User");
      expect(result.value.channelMappings).toHaveLength(1);
      expect(result.value.channelMappings[0]?.externalUserId).toBe("99999");
    });

    test("auto-create uses channel:id as name when no displayName", () => {
      const resolver = new ChannelResolver(manager, logger, {
        multiUserEnabled: true,
        autoCreateUsers: true,
      });

      const result = resolver.resolve({
        channelType: "discord",
        externalUserId: "disc456",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("discord:disc456");
    });

    test("falls back to default user when auto-create disabled", () => {
      const resolver = new ChannelResolver(manager, logger, {
        multiUserEnabled: true,
        autoCreateUsers: false,
      });

      const result = resolver.resolve({
        channelType: "telegram",
        externalUserId: "unknown",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBe(DEFAULT_USER_ID);
    });

    test("resolves same user for repeated calls", () => {
      const resolver = new ChannelResolver(manager, logger, {
        multiUserEnabled: true,
        autoCreateUsers: true,
      });

      const first = resolver.resolve({
        channelType: "telegram",
        externalUserId: "77777",
      });
      const second = resolver.resolve({
        channelType: "telegram",
        externalUserId: "77777",
      });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(first.value.id).toBe(second.value.id);
    });
  });

  describe("mapChannelToUser", () => {
    test("adds channel mapping to existing user", () => {
      manager.create({ id: "alice", name: "Alice" });
      const resolver = new ChannelResolver(manager, logger, {
        multiUserEnabled: true,
        autoCreateUsers: false,
      });

      const result = resolver.mapChannelToUser("alice", "telegram", "12345");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.channelMappings).toHaveLength(1);
      expect(result.value.channelMappings[0]?.channelType).toBe("telegram");
    });

    test("is idempotent for duplicate mappings", () => {
      manager.create({
        id: "alice",
        name: "Alice",
        channelMappings: [{ channelType: "telegram", externalUserId: "12345" }],
      });
      const resolver = new ChannelResolver(manager, logger, {
        multiUserEnabled: true,
        autoCreateUsers: false,
      });

      const result = resolver.mapChannelToUser("alice", "telegram", "12345");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.channelMappings).toHaveLength(1);
    });

    test("fails for non-existent user", () => {
      const resolver = new ChannelResolver(manager, logger, {
        multiUserEnabled: true,
        autoCreateUsers: false,
      });

      const result = resolver.mapChannelToUser("nonexistent", "telegram", "12345");
      expect(result.ok).toBe(false);
    });
  });
});
