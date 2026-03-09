/**
 * Tests for REST API route handlers.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConversationSessionStore } from "../../claude/session-store.ts";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import { DiscoveryEngine } from "../../learning/discovery.ts";
import type { Logger } from "../../logging/logger.ts";
import { MemoryStore } from "../../memory/store.ts";
import { handleRestApiRoute, handleRestApiRouteAsync, type RestApiDeps } from "../rest-api.ts";

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

function createOperationalDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error(`Migration failed: ${result.error.message}`);
  return db;
}

function createMemoryDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const result = runMigrations(db, "memory", MEMORY_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error(`Migration failed: ${result.error.message}`);
  return db;
}

function makeDeps(overrides?: Partial<RestApiDeps>): RestApiDeps {
  return {
    logger: createSilentLogger(),
    isTls: false,
    ...overrides,
  };
}

function makeRequest(path: string, method = "GET"): { req: Request; url: URL } {
  const fullUrl = `http://localhost:8419${path}`;
  return {
    req: new Request(fullUrl, { method }),
    url: new URL(fullUrl),
  };
}

async function getJson(response: Response): Promise<unknown> {
  return response.json();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("REST API", () => {
  describe("GET /api/conversations", () => {
    test("returns 503 when store not available", () => {
      const { req, url } = makeRequest("/api/conversations");
      const response = handleRestApiRoute(req, url, makeDeps());
      expect(response).not.toBeNull();
      expect(response?.status).toBe(503);
    });

    test("returns empty list", async () => {
      const db = createOperationalDb();
      const store = new ConversationSessionStore(db, createSilentLogger());
      const { req, url } = makeRequest("/api/conversations");

      const response = handleRestApiRoute(req, url, makeDeps({ conversationStore: store }));
      expect(response).not.toBeNull();
      expect(response?.status).toBe(200);

      const body = (await getJson(response!)) as { conversations: unknown[]; total: number };
      expect(body.conversations).toEqual([]);
      expect(body.total).toBe(0);
      db.close();
    });

    test("returns created conversations", async () => {
      const db = createOperationalDb();
      const store = new ConversationSessionStore(db, createSilentLogger());
      store.create({ channelId: "gateway", userId: "user1" });
      store.create({ title: "Chat 2", channelId: "gateway", userId: "user1" });

      const { req, url } = makeRequest("/api/conversations");
      const response = handleRestApiRoute(req, url, makeDeps({ conversationStore: store }));
      expect(response?.status).toBe(200);

      const body = (await getJson(response!)) as { conversations: unknown[]; total: number };
      expect(body.conversations.length).toBe(2);
      expect(body.total).toBe(2);
      db.close();
    });
  });

  describe("POST /api/conversations", () => {
    test("creates a new conversation", async () => {
      const db = createOperationalDb();
      const store = new ConversationSessionStore(db, createSilentLogger());

      const fullUrl = "http://localhost:8419/api/conversations";
      const req = new Request(fullUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Test Chat" }),
      });
      const urlObj = new URL(fullUrl);

      const response = await handleRestApiRouteAsync(req, urlObj, makeDeps({ conversationStore: store }));
      expect(response).not.toBeNull();
      expect(response?.status).toBe(201);

      const body = (await getJson(response!)) as { conversation: { title: string } };
      expect(body.conversation.title).toBe("Test Chat");
      db.close();
    });
  });

  describe("GET /api/conversations/:id/messages", () => {
    test("returns messages for a conversation", async () => {
      const db = createOperationalDb();
      const store = new ConversationSessionStore(db, createSilentLogger());
      const conv = store.create({ channelId: "gateway", userId: "user1" });
      if (!conv.ok) throw new Error("Failed to create conversation");

      store.addMessage({ conversationId: conv.value.id, role: "user", content: "Hello" });
      store.addMessage({ conversationId: conv.value.id, role: "assistant", content: "Hi" });

      const { req, url } = makeRequest(`/api/conversations/${conv.value.id}/messages`);
      const response = handleRestApiRoute(req, url, makeDeps({ conversationStore: store }));
      expect(response?.status).toBe(200);

      const body = (await getJson(response!)) as { messages: unknown[]; total: number };
      expect(body.messages.length).toBe(2);
      db.close();
    });
  });

  describe("GET /api/memories", () => {
    test("returns 503 when store not available", () => {
      const { req, url } = makeRequest("/api/memories");
      const response = handleRestApiRoute(req, url, makeDeps());
      expect(response).not.toBeNull();
      expect(response?.status).toBe(503);
    });

    test("returns memories", async () => {
      const db = createMemoryDb();
      const store = new MemoryStore(db, createSilentLogger());
      store.create({
        type: "fact",
        layer: "long_term",
        content: "Test memory content",
        confidence: 0.9,
        source: "test",
        tags: ["test"],
      });

      const { req, url } = makeRequest("/api/memories");
      const response = handleRestApiRoute(req, url, makeDeps({ memoryStore: store }));
      expect(response?.status).toBe(200);

      const body = (await getJson(response!)) as { memories: unknown[]; total: number };
      expect(body.memories.length).toBe(1);
      db.close();
    });
  });

  describe("GET /api/memories/search", () => {
    test("returns 400 without query param", () => {
      const db = createMemoryDb();
      const store = new MemoryStore(db, createSilentLogger());
      const { req, url } = makeRequest("/api/memories/search");
      const response = handleRestApiRoute(req, url, makeDeps({ memoryStore: store }));
      expect(response?.status).toBe(400);
      db.close();
    });

    test("returns search results", async () => {
      const db = createMemoryDb();
      const store = new MemoryStore(db, createSilentLogger());
      store.create({
        type: "fact",
        layer: "long_term",
        content: "TypeScript is a programming language",
        confidence: 0.9,
        source: "test",
        tags: ["test"],
      });

      const { req, url } = makeRequest("/api/memories/search?q=TypeScript");
      const response = handleRestApiRoute(req, url, makeDeps({ memoryStore: store }));
      expect(response?.status).toBe(200);

      const body = (await getJson(response!)) as { results: unknown[]; total: number };
      expect(body.results.length).toBe(1);
      db.close();
    });
  });

  describe("GET /api/learning/discoveries", () => {
    test("returns 503 when engine not available", () => {
      const { req, url } = makeRequest("/api/learning/discoveries");
      const response = handleRestApiRoute(req, url, makeDeps());
      expect(response?.status).toBe(503);
    });

    test("returns empty discoveries", async () => {
      const db = createOperationalDb();
      const engine = new DiscoveryEngine(db, createSilentLogger());

      const { req, url } = makeRequest("/api/learning/discoveries");
      const response = handleRestApiRoute(req, url, makeDeps({ discoveryEngine: engine }));
      expect(response?.status).toBe(200);

      const body = (await getJson(response!)) as { discoveries: unknown[] };
      expect(body.discoveries).toEqual([]);
      db.close();
    });

    test("returns discoveries filtered by status", async () => {
      const db = createOperationalDb();
      const engine = new DiscoveryEngine(db, createSilentLogger());
      engine.create({
        sourceType: "hackernews",
        url: "https://example.com/article",
        title: "Test Article",
        content: "Some content",
        relevanceScore: 0.8,
        safetyLevel: "safe",
      });

      const { req, url } = makeRequest("/api/learning/discoveries?status=new");
      const response = handleRestApiRoute(req, url, makeDeps({ discoveryEngine: engine }));
      expect(response?.status).toBe(200);

      const body = (await getJson(response!)) as { discoveries: unknown[]; total: number };
      expect(body.discoveries.length).toBe(1);
      db.close();
    });
  });

  describe("auth", () => {
    test("rejects requests without token when auth is configured", () => {
      const { req, url } = makeRequest("/api/conversations");
      const response = handleRestApiRoute(req, url, makeDeps({ authToken: "secret-token" }));
      expect(response?.status).toBe(401);
    });

    test("accepts requests with correct token", async () => {
      const db = createOperationalDb();
      const store = new ConversationSessionStore(db, createSilentLogger());

      const fullUrl = "http://localhost:8419/api/conversations";
      const req = new Request(fullUrl, {
        method: "GET",
        headers: { Authorization: "Bearer secret-token" },
      });
      const urlObj = new URL(fullUrl);

      const response = handleRestApiRoute(req, urlObj, makeDeps({
        authToken: "secret-token",
        conversationStore: store,
      }));
      expect(response?.status).toBe(200);
      db.close();
    });
  });

  describe("unknown route", () => {
    test("returns null for unknown /api/ paths", () => {
      const { req, url } = makeRequest("/api/unknown");
      const response = handleRestApiRoute(req, url, makeDeps());
      expect(response).toBeNull();
    });
  });
});
