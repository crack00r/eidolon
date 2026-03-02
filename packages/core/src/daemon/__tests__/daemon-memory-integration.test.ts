/**
 * Integration tests for the memory pipeline end-to-end.
 *
 * Tests MemoryStore CRUD, FTS5 text search, MemoryExtractor rule-based
 * extraction, and the full create-search-update-delete lifecycle.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import type { ConversationTurn } from "../../memory/extractor.ts";
import { MemoryExtractor } from "../../memory/extractor.ts";
import type { CreateMemoryInput } from "../../memory/store.ts";
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
  if (!result.ok) {
    throw new Error(`Migration failed: ${result.error.message}`);
  }
  return db;
}

function makeInput(overrides?: Partial<CreateMemoryInput>): CreateMemoryInput {
  return {
    type: "fact",
    layer: "long_term",
    content: "Default test memory content for integration tests",
    confidence: 0.9,
    source: "integration-test",
    tags: ["test"],
    metadata: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Daemon Memory Integration", () => {
  let db: Database;
  let store: MemoryStore;

  beforeEach(() => {
    db = createTestDb();
    store = new MemoryStore(db, createSilentLogger());
  });

  afterEach(() => {
    db.close();
  });

  // -------------------------------------------------------------------------
  // 1. Memory create and retrieve by ID
  // -------------------------------------------------------------------------

  describe("Memory create and retrieve by ID", () => {
    test("creates a memory about user preferences and retrieves it by ID", () => {
      const createResult = store.create(
        makeInput({
          type: "preference",
          layer: "long_term",
          content: "User prefers dark mode",
          confidence: 0.95,
          source: "user-conversation",
          tags: ["ui", "preference"],
        }),
      );

      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const created = createResult.value;
      expect(created.id).toBeDefined();
      expect(created.type).toBe("preference");
      expect(created.layer).toBe("long_term");
      expect(created.content).toBe("User prefers dark mode");
      expect(created.confidence).toBe(0.95);
      expect(created.source).toBe("user-conversation");
      expect(created.tags).toEqual(["ui", "preference"]);
      expect(created.accessCount).toBe(0);
      expect(created.createdAt).toBeGreaterThan(0);

      // Retrieve by ID
      const getResult = store.get(created.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      const retrieved = getResult.value;
      expect(retrieved).not.toBeNull();
      if (!retrieved) return;

      expect(retrieved.id).toBe(created.id);
      expect(retrieved.content).toBe("User prefers dark mode");
      expect(retrieved.type).toBe("preference");
      expect(retrieved.confidence).toBe(0.95);
      // get() touches the memory: accessCount increments
      expect(retrieved.accessCount).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Memory text search (BM25)
  // -------------------------------------------------------------------------

  describe("Memory text search (BM25)", () => {
    test("searches for 'dark mode' and returns the relevant memory first", () => {
      store.create(
        makeInput({
          content: "User prefers dark mode for all editors and terminals",
          tags: ["ui", "preference"],
        }),
      );
      store.create(
        makeInput({
          content: "The server runs Ubuntu 22.04 LTS",
          tags: ["server", "os"],
        }),
      );
      store.create(
        makeInput({
          content: "Deployment uses Docker containers on port 8080",
          tags: ["deployment", "docker"],
        }),
      );

      const searchResult = store.searchText("dark mode");
      expect(searchResult.ok).toBe(true);
      if (!searchResult.ok) return;

      expect(searchResult.value.length).toBeGreaterThanOrEqual(1);
      // The dark mode memory should be the top result
      expect(searchResult.value[0]?.memory.content).toContain("dark mode");
      // Rank should be positive (negated from FTS5 internal negative rank)
      expect(searchResult.value[0]?.rank).toBeGreaterThan(0);
    });

    test("returns empty results for a query with no matches", () => {
      store.create(makeInput({ content: "TypeScript is great for type safety" }));
      store.create(makeInput({ content: "Bun is a fast JavaScript runtime" }));

      const searchResult = store.searchText("quantum computing");
      expect(searchResult.ok).toBe(true);
      if (!searchResult.ok) return;

      expect(searchResult.value).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Memory extractor extracts facts from conversation text
  // -------------------------------------------------------------------------

  describe("Memory extractor extracts facts from conversation text", () => {
    test("extracts location from German conversation", async () => {
      const extractor = new MemoryExtractor(createSilentLogger(), {
        strategy: "rule-based",
        minContentLength: 3, // Lower threshold so short place names are captured
      });

      const turn: ConversationTurn = {
        userMessage: "Ich heiße Manuel und ich wohne in Berlin-Kreuzberg",
        assistantResponse: "Hallo Manuel! Schön, dass du in Berlin wohnst.",
      };

      const result = await extractor.extract(turn);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Should extract at least name or location
      expect(result.value.length).toBeGreaterThanOrEqual(1);

      // Check for personal info extraction
      const personalMemories = result.value.filter((m) => m.tags.includes("personal"));
      expect(personalMemories.length).toBeGreaterThanOrEqual(1);

      // Should find location (ich wohne in Berlin-Kreuzberg)
      const locationMemory = personalMemories.find((m) => m.content.toLowerCase().includes("berlin"));
      expect(locationMemory).toBeDefined();
      expect(locationMemory?.type).toBe("fact");
      expect(locationMemory?.confidence).toBeGreaterThanOrEqual(0.7);

      // All extracted memories should be rule-based
      expect(result.value.every((m) => m.source === "rule_based")).toBe(true);
    });

    test("converts extracted memories to CreateMemoryInput and stores them", async () => {
      const extractor = new MemoryExtractor(createSilentLogger(), {
        strategy: "rule-based",
      });

      const turn: ConversationTurn = {
        userMessage: "I prefer using Vim for all my editing",
        assistantResponse: "Vim is a powerful editor!",
      };

      const extractResult = await extractor.extract(turn);
      expect(extractResult.ok).toBe(true);
      if (!extractResult.ok) return;
      expect(extractResult.value.length).toBeGreaterThanOrEqual(1);

      // Convert to store inputs
      const inputs = extractor.toCreateInputs(extractResult.value, "test-session-123");
      expect(inputs.length).toBeGreaterThanOrEqual(1);
      expect(inputs[0]?.layer).toBe("short_term");
      expect(inputs[0]?.source).toContain("extraction:");

      // Store them
      const batchResult = store.createBatch(inputs);
      expect(batchResult.ok).toBe(true);
      if (!batchResult.ok) return;

      expect(batchResult.value.length).toBe(inputs.length);

      // Verify they exist in the database
      const countResult = store.count();
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) return;
      expect(countResult.value).toBe(inputs.length);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Memory create + search integration (diverse types)
  // -------------------------------------------------------------------------

  describe("Memory create + search integration", () => {
    test("creates 5 diverse memories and searches for each category", () => {
      // Create 5 diverse memories
      const memories: CreateMemoryInput[] = [
        makeInput({
          type: "preference",
          content: "User prefers dark mode and monospace fonts in all editors",
          tags: ["ui", "preference", "editor"],
          confidence: 0.9,
        }),
        makeInput({
          type: "fact",
          content: "The production server runs Ubuntu 22.04 LTS on AWS EC2",
          tags: ["infrastructure", "server", "aws"],
          confidence: 0.95,
        }),
        makeInput({
          type: "decision",
          content: "We decided to use PostgreSQL instead of MySQL for the main database",
          tags: ["database", "architecture", "decision"],
          confidence: 0.92,
        }),
        makeInput({
          type: "skill",
          layer: "procedural",
          content: "Deploy the application using Docker Compose with nginx reverse proxy",
          tags: ["deployment", "docker", "skill"],
          confidence: 0.88,
        }),
        makeInput({
          type: "fact",
          content: "TODO: Update SSL certificates before December 2026 deadline",
          tags: ["todo", "security", "maintenance"],
          confidence: 0.85,
        }),
      ];

      const batchResult = store.createBatch(memories);
      expect(batchResult.ok).toBe(true);
      if (!batchResult.ok) return;
      expect(batchResult.value).toHaveLength(5);

      // Search for preference-related content (searchText wraps in quotes = phrase search)
      const prefSearch = store.searchText("dark mode");
      expect(prefSearch.ok).toBe(true);
      if (!prefSearch.ok) return;
      expect(prefSearch.value.length).toBeGreaterThanOrEqual(1);
      expect(prefSearch.value[0]?.memory.content).toContain("dark mode");

      // Search for infrastructure content
      const infraSearch = store.searchText("Ubuntu");
      expect(infraSearch.ok).toBe(true);
      if (!infraSearch.ok) return;
      expect(infraSearch.value.length).toBeGreaterThanOrEqual(1);
      expect(infraSearch.value[0]?.memory.content).toContain("Ubuntu");

      // Search for database decision
      const dbSearch = store.searchText("PostgreSQL");
      expect(dbSearch.ok).toBe(true);
      if (!dbSearch.ok) return;
      expect(dbSearch.value.length).toBeGreaterThanOrEqual(1);
      expect(dbSearch.value[0]?.memory.content).toContain("PostgreSQL");

      // Search for deployment skill
      const deploySearch = store.searchText("Docker Compose");
      expect(deploySearch.ok).toBe(true);
      if (!deploySearch.ok) return;
      expect(deploySearch.value.length).toBeGreaterThanOrEqual(1);
      expect(deploySearch.value[0]?.memory.content).toContain("Docker Compose");

      // Search for SSL todo
      const todoSearch = store.searchText("SSL certificates");
      expect(todoSearch.ok).toBe(true);
      if (!todoSearch.ok) return;
      expect(todoSearch.value.length).toBeGreaterThanOrEqual(1);
      expect(todoSearch.value[0]?.memory.content).toContain("SSL certificates");

      // Verify list filtering by type
      const factList = store.list({ types: ["fact"] });
      expect(factList.ok).toBe(true);
      if (!factList.ok) return;
      expect(factList.value).toHaveLength(2); // server fact + SSL todo fact

      const skillList = store.list({ types: ["skill"] });
      expect(skillList.ok).toBe(true);
      if (!skillList.ok) return;
      expect(skillList.value).toHaveLength(1);
      expect(skillList.value[0]?.layer).toBe("procedural");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Memory update and delete
  // -------------------------------------------------------------------------

  describe("Memory update and delete", () => {
    test("creates a memory, updates its content, then deletes it", () => {
      // Create
      const createResult = store.create(
        makeInput({
          content: "The API endpoint is http://localhost:3000",
          confidence: 0.8,
          tags: ["api", "config"],
        }),
      );
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const memoryId = createResult.value.id;

      // Update content
      const updateResult = store.update(memoryId, {
        content: "The API endpoint is http://api.example.com:8080",
        confidence: 0.95,
        tags: ["api", "config", "production"],
      });
      expect(updateResult.ok).toBe(true);
      if (!updateResult.ok) return;

      expect(updateResult.value.content).toBe("The API endpoint is http://api.example.com:8080");
      expect(updateResult.value.confidence).toBe(0.95);
      expect(updateResult.value.tags).toEqual(["api", "config", "production"]);
      expect(updateResult.value.updatedAt).toBeGreaterThanOrEqual(createResult.value.updatedAt);

      // Verify update persists via get
      const getResult = store.get(memoryId);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value).not.toBeNull();
      if (!getResult.value) return;
      expect(getResult.value.content).toBe("The API endpoint is http://api.example.com:8080");

      // Verify FTS index updated: search for the new content
      const searchNew = store.searchText("api.example.com");
      expect(searchNew.ok).toBe(true);
      if (!searchNew.ok) return;
      expect(searchNew.value.length).toBeGreaterThanOrEqual(1);
      expect(searchNew.value[0]?.memory.id).toBe(memoryId);

      // Delete
      const deleteResult = store.delete(memoryId);
      expect(deleteResult.ok).toBe(true);

      // Verify gone
      const afterDelete = store.get(memoryId);
      expect(afterDelete.ok).toBe(true);
      if (!afterDelete.ok) return;
      expect(afterDelete.value).toBeNull();

      // Verify count is zero
      const countResult = store.count();
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) return;
      expect(countResult.value).toBe(0);
    });

    test("update returns error for non-existent memory", () => {
      const result = store.update("non-existent-id-12345", {
        content: "This should fail",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DB_QUERY_FAILED");
      expect(result.error.message).toContain("not found");
    });

    test("delete returns error for non-existent memory", () => {
      const result = store.delete("non-existent-id-12345");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("DB_QUERY_FAILED");
      expect(result.error.message).toContain("not found");
    });
  });

  // -------------------------------------------------------------------------
  // 6. Duplicate detection
  // -------------------------------------------------------------------------

  describe("Duplicate detection", () => {
    test("stores two memories with similar content — both exist", () => {
      const result1 = store.create(
        makeInput({
          content: "User prefers dark mode in VS Code",
          tags: ["preference", "vscode"],
        }),
      );
      const result2 = store.create(
        makeInput({
          content: "User prefers dark mode in all editors",
          tags: ["preference", "editor"],
        }),
      );

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      // Both should have unique IDs
      expect(result1.value.id).not.toBe(result2.value.id);

      // Both should exist in the store
      const countResult = store.count();
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) return;
      expect(countResult.value).toBe(2);

      // Searching should return both
      const searchResult = store.searchText("dark mode");
      expect(searchResult.ok).toBe(true);
      if (!searchResult.ok) return;
      expect(searchResult.value).toHaveLength(2);
    });

    test("stores two memories with identical content — both persist with unique IDs", () => {
      const content = "The deployment server IP is 10.0.0.42";

      const result1 = store.create(
        makeInput({
          content,
          source: "session-1",
        }),
      );
      const result2 = store.create(
        makeInput({
          content,
          source: "session-2",
        }),
      );

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      if (!result1.ok || !result2.ok) return;

      // Unique IDs even with identical content
      expect(result1.value.id).not.toBe(result2.value.id);

      // Both exist
      const listResult = store.list();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value).toHaveLength(2);
      expect(listResult.value.every((m) => m.content === content)).toBe(true);

      // Different sources preserved
      const sources = new Set(listResult.value.map((m) => m.source));
      expect(sources.has("session-1")).toBe(true);
      expect(sources.has("session-2")).toBe(true);
    });

    test("extractor deduplicates at extraction level before storage", async () => {
      const extractor = new MemoryExtractor(createSilentLogger(), {
        strategy: "rule-based",
      });

      // Both user and assistant say the same preference — extractor should deduplicate
      const turn: ConversationTurn = {
        userMessage: "I prefer using TypeScript for all projects",
        assistantResponse: "I prefer using TypeScript for all projects",
      };

      const extractResult = await extractor.extract(turn);
      expect(extractResult.ok).toBe(true);
      if (!extractResult.ok) return;

      // Should deduplicate: only one entry for TypeScript preference
      const tsPrefs = extractResult.value.filter((m) => m.content.toLowerCase().includes("typescript"));
      expect(tsPrefs).toHaveLength(1);
      // User-sourced confidence (0.85) should win over assistant-sourced (0.85 * 0.8)
      expect(tsPrefs[0]?.confidence).toBe(0.85);
    });
  });
});
