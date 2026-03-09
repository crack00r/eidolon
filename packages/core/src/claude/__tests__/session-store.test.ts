/**
 * Tests for ConversationSessionStore.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { ConversationSessionStore } from "../session-store.ts";

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

describe("ConversationSessionStore", () => {
  let db: Database;
  let store: ConversationSessionStore;

  beforeEach(() => {
    db = createTestDb();
    store = new ConversationSessionStore(db, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  describe("create", () => {
    test("creates a conversation with defaults", () => {
      const result = store.create({ channelId: "gateway", userId: "user1" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.id).toBeDefined();
      expect(result.value.title).toBe("New Conversation");
      expect(result.value.channelId).toBe("gateway");
      expect(result.value.userId).toBe("user1");
      expect(result.value.messageCount).toBe(0);
      expect(result.value.claudeSessionId).toBeNull();
    });

    test("creates a conversation with custom title", () => {
      const result = store.create({
        title: "My Chat",
        channelId: "telegram",
        userId: "user2",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.title).toBe("My Chat");
    });
  });

  describe("get", () => {
    test("returns null for non-existent conversation", () => {
      const result = store.get("non-existent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    test("returns existing conversation", () => {
      const createResult = store.create({ channelId: "gateway", userId: "user1" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = store.get(createResult.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value?.id).toBe(createResult.value.id);
    });
  });

  describe("list", () => {
    test("lists all conversations", () => {
      store.create({ channelId: "gateway", userId: "user1" });
      store.create({ title: "Second", channelId: "gateway", userId: "user1" });
      store.create({ title: "Third", channelId: "gateway", userId: "user1" });

      const result = store.list();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(3);
    });

    test("filters by userId", () => {
      store.create({ channelId: "gateway", userId: "user1" });
      store.create({ channelId: "gateway", userId: "user2" });

      const result = store.list({ userId: "user1" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.userId).toBe("user1");
    });

    test("respects limit and offset", () => {
      for (let i = 0; i < 5; i++) {
        store.create({ title: `Conv ${i}`, channelId: "gateway", userId: "user1" });
      }

      const result = store.list({ limit: 2, offset: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });
  });

  describe("setClaudeSessionId", () => {
    test("sets the claude session ID", () => {
      const createResult = store.create({ channelId: "gateway", userId: "user1" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const setResult = store.setClaudeSessionId(createResult.value.id, "claude-session-123");
      expect(setResult.ok).toBe(true);

      const getResult = store.get(createResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.claudeSessionId).toBe("claude-session-123");
    });
  });

  describe("updateTitle", () => {
    test("updates the conversation title", () => {
      const createResult = store.create({ channelId: "gateway", userId: "user1" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const updateResult = store.updateTitle(createResult.value.id, "Updated Title");
      expect(updateResult.ok).toBe(true);

      const getResult = store.get(createResult.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.title).toBe("Updated Title");
    });
  });

  describe("addMessage", () => {
    test("adds a user message and increments count", () => {
      const createResult = store.create({ channelId: "gateway", userId: "user1" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const convId = createResult.value.id;

      const msgResult = store.addMessage({
        conversationId: convId,
        role: "user",
        content: "Hello!",
      });
      expect(msgResult.ok).toBe(true);
      if (!msgResult.ok) return;
      expect(msgResult.value.role).toBe("user");
      expect(msgResult.value.content).toBe("Hello!");

      const getResult = store.get(convId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.messageCount).toBe(1);
    });

    test("adds multiple messages in order", () => {
      const createResult = store.create({ channelId: "gateway", userId: "user1" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const convId = createResult.value.id;

      store.addMessage({ conversationId: convId, role: "user", content: "Hello!" });
      store.addMessage({ conversationId: convId, role: "assistant", content: "Hi there!" });
      store.addMessage({ conversationId: convId, role: "user", content: "How are you?" });

      const getResult = store.get(convId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.messageCount).toBe(3);
    });

    test("rejects overly long content", () => {
      const createResult = store.create({ channelId: "gateway", userId: "user1" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const longContent = "x".repeat(600_000);
      const msgResult = store.addMessage({
        conversationId: createResult.value.id,
        role: "user",
        content: longContent,
      });
      expect(msgResult.ok).toBe(false);
    });
  });

  describe("getMessages", () => {
    test("returns messages in chronological order", () => {
      const createResult = store.create({ channelId: "gateway", userId: "user1" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const convId = createResult.value.id;

      store.addMessage({ conversationId: convId, role: "user", content: "First" });
      store.addMessage({ conversationId: convId, role: "assistant", content: "Second" });

      const msgsResult = store.getMessages(convId);
      expect(msgsResult.ok).toBe(true);
      if (!msgsResult.ok) return;
      expect(msgsResult.value.length).toBe(2);
      expect(msgsResult.value[0]?.content).toBe("First");
      expect(msgsResult.value[1]?.content).toBe("Second");
    });

    test("respects limit", () => {
      const createResult = store.create({ channelId: "gateway", userId: "user1" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const convId = createResult.value.id;

      for (let i = 0; i < 5; i++) {
        store.addMessage({ conversationId: convId, role: "user", content: `Msg ${i}` });
      }

      const msgsResult = store.getMessages(convId, { limit: 3 });
      expect(msgsResult.ok).toBe(true);
      if (!msgsResult.ok) return;
      expect(msgsResult.value.length).toBe(3);
    });
  });

  describe("delete", () => {
    test("deletes conversation and its messages", () => {
      const createResult = store.create({ channelId: "gateway", userId: "user1" });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;
      const convId = createResult.value.id;

      store.addMessage({ conversationId: convId, role: "user", content: "Hello" });
      store.addMessage({ conversationId: convId, role: "assistant", content: "Hi" });

      const deleteResult = store.delete(convId);
      expect(deleteResult.ok).toBe(true);

      const getResult = store.get(convId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).toBeNull();

      const msgsResult = store.getMessages(convId);
      expect(msgsResult.ok).toBe(true);
      if (!msgsResult.ok) return;
      expect(msgsResult.value.length).toBe(0);
    });
  });
});
