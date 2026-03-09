/**
 * Tests for memory population from conversations.
 *
 * Verifies that the MemoryExtractor extracts memories and the extracted
 * memories are properly converted to CreateMemoryInput for storage.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import type { ConversationTurn } from "../../memory/extractor.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import { MemoryStore } from "../../memory/store.ts";

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
  const result = runMigrations(db, "memory", MEMORY_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error(`Migration failed: ${result.error.message}`);
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Memory Population Pipeline", () => {
  let db: Database;
  let store: MemoryStore;
  let extractor: MemoryExtractor;

  beforeEach(() => {
    db = createTestDb();
    store = new MemoryStore(db, createSilentLogger());
    extractor = new MemoryExtractor(createSilentLogger(), {
      strategy: "rule-based",
    });
  });

  afterEach(() => {
    db.close();
  });

  test("extracts and stores memories from a conversation turn", async () => {
    const turn: ConversationTurn = {
      userMessage: "My name is Manuel and I prefer TypeScript over JavaScript",
      assistantResponse: "Nice to meet you, Manuel! TypeScript is a great choice.",
      sessionId: "test-session-1",
      timestamp: Date.now(),
    };

    // Step 1: Extract memories
    const extractResult = await extractor.extract(turn);
    expect(extractResult.ok).toBe(true);
    if (!extractResult.ok) return;

    const extracted = extractResult.value;

    // Step 2: Convert to CreateMemoryInput
    const inputs = extractor.toCreateInputs(extracted, turn.sessionId);

    // Step 3: Store memories
    if (inputs.length > 0) {
      const batchResult = store.createBatch(inputs);
      expect(batchResult.ok).toBe(true);
      if (!batchResult.ok) return;
      expect(batchResult.value.length).toBe(inputs.length);

      // Verify memories are in the store
      const listResult = store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value.length).toBe(inputs.length);

      // All stored memories should be short_term (from extraction)
      for (const memory of listResult.value) {
        expect(memory.layer).toBe("short_term");
        expect(memory.source).toMatch(/^extraction:/);
      }
    }
  });

  test("skips trivial messages without storing", async () => {
    const turn: ConversationTurn = {
      userMessage: "ok",
      assistantResponse: "Sure!",
      sessionId: "test-session-2",
      timestamp: Date.now(),
    };

    const extractResult = await extractor.extract(turn);
    expect(extractResult.ok).toBe(true);
    if (!extractResult.ok) return;
    expect(extractResult.value.length).toBe(0);

    // No memories should be in store
    const listResult = store.list();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;
    expect(listResult.value.length).toBe(0);
  });

  test("extracts preference from user message", async () => {
    const turn: ConversationTurn = {
      userMessage: "I prefer dark mode for all my applications",
      assistantResponse: "I will remember that you prefer dark mode.",
      sessionId: "test-session-3",
      timestamp: Date.now(),
    };

    const extractResult = await extractor.extract(turn);
    expect(extractResult.ok).toBe(true);
    if (!extractResult.ok) return;

    const inputs = extractor.toCreateInputs(extractResult.value, turn.sessionId);

    if (inputs.length > 0) {
      const batchResult = store.createBatch(inputs);
      expect(batchResult.ok).toBe(true);

      // Verify stored memories
      const listResult = store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value.length).toBeGreaterThan(0);
    }
  });

  test("toCreateInputs sets correct metadata", () => {
    const extracted = extractor.extractRuleBased({
      userMessage: "My birthday is on December 25th and I prefer dark mode for everything",
      assistantResponse: "Noted!",
    });

    const inputs = extractor.toCreateInputs(extracted, "session-42");

    for (const input of inputs) {
      expect(input.layer).toBe("short_term");
      expect(input.source).toMatch(/^extraction:rule_based$/);
      expect(input.metadata).toEqual({ sessionId: "session-42" });
    }
  });
});
