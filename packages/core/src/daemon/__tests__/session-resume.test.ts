/**
 * Tests for session resumption in the user message handler.
 *
 * Verifies that:
 * - Claude CLI session IDs are captured from stream events and stored
 * - Subsequent messages for the same conversation use --resume
 * - Failed resume attempts fall back to a fresh session
 * - Different conversations get independent session IDs
 */

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import type { ClaudeSessionOptions, EidolonError, EventPriority, Result, StreamEvent } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { FakeClaudeProcess } from "@eidolon/test-utils";
import { ConversationSessionStore } from "../../claude/session-store.ts";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { handleUserMessage } from "../event-handlers-user.ts";
import type { InitializedModules } from "../types.ts";

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

function createOperationalDb(): Database {
  const db = new Database(":memory:");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger);
  if (!result.ok) throw new Error("Migration failed");
  return db;
}

interface MockRouterCall {
  readonly channelId: string;
  readonly text: string;
}

function createMockRouter(): {
  routeOutbound: (msg: Record<string, unknown>) => Promise<Result<void, EidolonError>>;
  calls: MockRouterCall[];
} {
  const calls: MockRouterCall[] = [];
  return {
    routeOutbound: async (msg: Record<string, unknown>): Promise<Result<void, EidolonError>> => {
      calls.push({
        channelId: msg.channelId as string,
        text: msg.text as string,
      });
      return Ok(undefined);
    },
    calls,
  };
}

function createMockWorkspacePreparer(): {
  prepare: (id: string, opts: Record<string, unknown>) => Promise<Result<string, EidolonError>>;
  cleanup: (id: string) => void;
  cleanedUp: string[];
} {
  const cleanedUp: string[] = [];
  return {
    prepare: async (): Promise<Result<string, EidolonError>> => Ok("/tmp/test-workspace"),
    cleanup: (id: string): void => {
      cleanedUp.push(id);
    },
    cleanedUp,
  };
}

function makeEvent(
  channelId: string,
  userId: string,
  text: string,
): { readonly id: string; readonly payload: unknown } {
  return {
    id: `evt-${Date.now()}-${Math.random()}`,
    payload: { channelId, userId, text },
  };
}

function makeMinimalConfig(): Record<string, unknown> {
  return {
    identity: { ownerName: "Test User" },
    brain: {
      model: { default: "claude-sonnet-4-20250514" },
      session: { timeoutMs: 30000 },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("session resume in handleUserMessage", () => {
  let sessionStore: ConversationSessionStore;
  let mockRouter: ReturnType<typeof createMockRouter>;
  let mockWorkspace: ReturnType<typeof createMockWorkspacePreparer>;

  beforeEach(() => {
    sessionStore = new ConversationSessionStore();
    mockRouter = createMockRouter();
    mockWorkspace = createMockWorkspacePreparer();
  });

  function buildModules(fakeProcess: FakeClaudeProcess): InitializedModules {
    return {
      logger,
      config: makeMinimalConfig() as InitializedModules["config"],
      claudeManager: fakeProcess as unknown as InitializedModules["claudeManager"],
      conversationSessionStore: sessionStore,
      workspacePreparer: mockWorkspace as unknown as InitializedModules["workspacePreparer"],
      messageRouter: mockRouter as unknown as InitializedModules["messageRouter"],
    };
  }

  test("captures session ID from stream and stores it", async () => {
    const fake = new FakeClaudeProcess();
    fake.addRule(/./, [
      { type: "text", content: "Hello!", timestamp: Date.now() },
      { type: "session", sessionId: "claude-session-123", timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    const modules = buildModules(fake);
    const result = await handleUserMessage(modules, makeEvent("telegram", "user1", "Hi"), logger);

    expect(result.success).toBe(true);
    expect(sessionStore.get("telegram::user1")).toBe("claude-session-123");
  });

  test("passes resumeSessionId on second message for same conversation", async () => {
    // Pre-populate the session store
    sessionStore.set("telegram::user1", "claude-session-abc");

    const fake = new FakeClaudeProcess();
    fake.addRule(/./, [
      { type: "text", content: "Follow-up response", timestamp: Date.now() },
      { type: "session", sessionId: "claude-session-def", timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    const modules = buildModules(fake);
    await handleUserMessage(modules, makeEvent("telegram", "user1", "Follow up"), logger);

    // Verify the call used resumeSessionId
    const lastOpts = fake.getLastOptions();
    expect(lastOpts?.resumeSessionId).toBe("claude-session-abc");

    // Verify the store was updated with the new session ID
    expect(sessionStore.get("telegram::user1")).toBe("claude-session-def");
  });

  test("first message for a conversation has no resumeSessionId", async () => {
    const fake = new FakeClaudeProcess();
    fake.addRule(/./, [
      { type: "text", content: "First response", timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    const modules = buildModules(fake);
    await handleUserMessage(modules, makeEvent("telegram", "user1", "Hello"), logger);

    const lastOpts = fake.getLastOptions();
    expect(lastOpts?.resumeSessionId).toBeUndefined();
  });

  test("different conversations get independent session IDs", async () => {
    const fake = new FakeClaudeProcess();
    const callCount = 0;
    // Use different session IDs for different calls
    fake.addRule(/./, [
      { type: "text", content: "Response", timestamp: Date.now() },
      { type: "session", sessionId: "session-A", timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    const modules = buildModules(fake);
    await handleUserMessage(modules, makeEvent("telegram", "user1", "Hello from user1"), logger);
    expect(sessionStore.get("telegram::user1")).toBe("session-A");

    // Add a different rule for the second call
    fake.reset();
    fake.addRule(/./, [
      { type: "text", content: "Response", timestamp: Date.now() },
      { type: "session", sessionId: "session-B", timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    await handleUserMessage(modules, makeEvent("discord", "user2", "Hello from user2"), logger);
    expect(sessionStore.get("discord::user2")).toBe("session-B");

    // user1's session should still be session-A
    expect(sessionStore.get("telegram::user1")).toBe("session-A");
  });

  test("does not store session ID when stream has errors", async () => {
    const fake = new FakeClaudeProcess();
    fake.addRule(/./, [
      { type: "text", content: "Partial", timestamp: Date.now() },
      { type: "session", sessionId: "should-not-store", timestamp: Date.now() },
      { type: "error", error: "Something went wrong", timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    const modules = buildModules(fake);
    await handleUserMessage(modules, makeEvent("telegram", "user1", "Hello"), logger);

    // Session ID should not be stored when there were errors
    expect(sessionStore.get("telegram::user1")).toBeUndefined();
  });

  test("no session event means no session stored", async () => {
    const fake = new FakeClaudeProcess();
    fake.addRule(/./, [
      { type: "text", content: "Response without session", timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    const modules = buildModules(fake);
    await handleUserMessage(modules, makeEvent("telegram", "user1", "Hello"), logger);

    expect(sessionStore.get("telegram::user1")).toBeUndefined();
  });

  test("works without conversationSessionStore (graceful degradation)", async () => {
    const fake = new FakeClaudeProcess();
    fake.addRule(/./, [
      { type: "text", content: "Response", timestamp: Date.now() },
      { type: "session", sessionId: "orphaned-session", timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    const modules = buildModules(fake);
    modules.conversationSessionStore = undefined;

    const result = await handleUserMessage(modules, makeEvent("telegram", "user1", "Hello"), logger);
    expect(result.success).toBe(true);

    // No crash, no session stored
    const lastOpts = fake.getLastOptions();
    expect(lastOpts?.resumeSessionId).toBeUndefined();
  });

  test("falls back to fresh session when resume fails", async () => {
    // Pre-populate with a "stale" session
    sessionStore.set("telegram::user1", "stale-session-id");

    // Create a fake that fails on resume but succeeds on fresh
    const fake = new FakeClaudeProcess();

    // First call (with resume) returns error
    fake.addRule(/./, [
      { type: "error", error: "Session expired", timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);

    const modules = buildModules(fake);
    const result = await handleUserMessage(modules, makeEvent("telegram", "user1", "Hello"), logger);

    // The call count should be 2: one with resume (empty response), one without
    expect(fake.getCallCount()).toBe(2);

    // First call should have had resumeSessionId
    const firstCall = fake.getCalls()[0];
    expect(firstCall?.options.resumeSessionId).toBe("stale-session-id");

    // Second call (fallback) should NOT have resumeSessionId
    const secondCall = fake.getCalls()[1];
    expect(secondCall?.options.resumeSessionId).toBeUndefined();

    // The stale session should have been removed
    expect(sessionStore.get("telegram::user1")).toBeUndefined();
  });
});
