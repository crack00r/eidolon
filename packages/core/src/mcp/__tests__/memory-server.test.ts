/**
 * Tests for the MemoryMcpServer.
 *
 * Uses in-memory SQLite with the memory schema applied.
 * Tests verify tool registration, memory search, memory add,
 * memory list, KG query, resource reads, and error handling.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import { KGEntityStore } from "../../memory/knowledge-graph/entities.ts";
import { KGRelationStore } from "../../memory/knowledge-graph/relations.ts";
import { MemoryStore } from "../../memory/store.ts";
import { MemoryMcpServer } from "../memory-server.ts";

// ---------------------------------------------------------------------------
// Test helpers
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
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  const logger = createSilentLogger();
  const result = runMigrations(db, "memory", MEMORY_MIGRATIONS, logger);
  if (!result.ok) {
    throw new Error(`Failed to run migrations: ${result.error.message}`);
  }
  return db;
}

interface TestContext {
  readonly db: Database;
  readonly store: MemoryStore;
  readonly kgEntities: KGEntityStore;
  readonly kgRelations: KGRelationStore;
  readonly server: MemoryMcpServer;
  readonly logger: Logger;
}

function createTestContext(): TestContext {
  const db = createTestDb();
  const logger = createSilentLogger();
  const store = new MemoryStore(db, logger);
  const kgEntities = new KGEntityStore(db, logger);
  const kgRelations = new KGRelationStore(db, logger);
  const server = new MemoryMcpServer({
    store,
    search: null,
    kgEntities,
    kgRelations,
    logger,
  });
  return { db, store, kgEntities, kgRelations, server, logger };
}

/**
 * Capture the JSON-RPC response written to stdout by the server.
 * We intercept process.stdout.write to capture the output.
 */
function captureOutput<T>(fn: () => void | Promise<void>): Promise<T> {
  return new Promise<T>((resolve) => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    let captured = "";

    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      if (typeof chunk === "string") {
        captured += chunk;
      }
      return true;
    }) as typeof process.stdout.write;

    const result = fn();
    const finish = (): void => {
      process.stdout.write = originalWrite;
      const trimmed = captured.trim();
      if (trimmed.length > 0) {
        resolve(JSON.parse(trimmed) as T);
      }
    };

    if (result instanceof Promise) {
      result.then(finish);
    } else {
      finish();
    }
  });
}

interface JsonRpcResult {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** Extract the text from the first content item of an MCP tool result. */
function getToolResultText(response: JsonRpcResult): string {
  const result = response.result as { content: Array<{ type: string; text: string }> } | undefined;
  const first = result?.content[0];
  if (!first) throw new Error("No tool result content");
  return first.text;
}

/** Extract parsed JSON from the first content item of an MCP tool result. */
function parseToolResult<T>(response: JsonRpcResult): T {
  return JSON.parse(getToolResultText(response)) as T;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryMcpServer", () => {
  describe("initialize", () => {
    test("responds with server info and capabilities", async () => {
      const { server } = createTestContext();
      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "init-1",
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "test", version: "0.1.0" },
            },
          }),
        ),
      );

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe("init-1");
      const result = response.result as Record<string, unknown>;
      expect(result.protocolVersion).toBe("2024-11-05");
      expect(result.capabilities).toBeDefined();
      const serverInfo = result.serverInfo as Record<string, string>;
      expect(serverInfo.name).toBe("eidolon-memory");
    });
  });

  describe("tools/list", () => {
    test("lists all four tools", async () => {
      const { server } = createTestContext();
      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "tools-1",
            method: "tools/list",
          }),
        ),
      );

      expect(response.id).toBe("tools-1");
      const result = response.result as { tools: Array<{ name: string }> };
      const toolNames = result.tools.map((t) => t.name);
      expect(toolNames).toContain("memory_search");
      expect(toolNames).toContain("memory_add");
      expect(toolNames).toContain("memory_list");
      expect(toolNames).toContain("kg_query");
      expect(result.tools).toHaveLength(4);
    });
  });

  describe("memory_search", () => {
    test("returns empty results for no matches", async () => {
      const { server } = createTestContext();
      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "search-1",
            method: "tools/call",
            params: {
              name: "memory_search",
              arguments: { query: "nonexistent topic" },
            },
          }),
        ),
      );

      expect(response.id).toBe("search-1");
      const parsed = parseToolResult<unknown[]>(response);
      expect(parsed).toHaveLength(0);
    });

    test("returns matching memories via text search", async () => {
      const { server, store } = createTestContext();

      // Add a memory first
      store.create({
        type: "fact",
        layer: "long_term",
        content: "TypeScript is the preferred language for the Eidolon core",
        confidence: 0.9,
        source: "test",
        tags: ["language", "eidolon"],
      });

      // FTS5 searchText wraps the query in quotes for exact phrase match.
      // Search for a single word that appears in the content.
      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "search-2",
            method: "tools/call",
            params: {
              name: "memory_search",
              arguments: { query: "TypeScript" },
            },
          }),
        ),
      );

      const parsed = parseToolResult<Array<{ content: string }>>(response);
      expect(parsed.length).toBeGreaterThan(0);
      expect(parsed[0]!.content).toContain("TypeScript");
    });

    test("rejects missing query parameter", async () => {
      const { server } = createTestContext();
      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "search-3",
            method: "tools/call",
            params: {
              name: "memory_search",
              arguments: {},
            },
          }),
        ),
      );

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32602);
    });
  });

  describe("memory_add", () => {
    test("creates a new memory and returns it", async () => {
      const { server, store } = createTestContext();

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "add-1",
            method: "tools/call",
            params: {
              name: "memory_add",
              arguments: {
                content: "The user prefers dark mode in all applications",
                type: "preference",
                tags: ["ui", "dark-mode"],
              },
            },
          }),
        ),
      );

      expect(response.id).toBe("add-1");
      const parsed = parseToolResult<{ id: string; type: string; content: string }>(response);
      expect(parsed.id).toBeDefined();
      expect(parsed.type).toBe("preference");
      expect(parsed.content).toContain("dark mode");

      // Verify in store
      const countResult = store.count(["preference"]);
      expect(countResult.ok).toBe(true);
      if (countResult.ok) {
        expect(countResult.value).toBe(1);
      }
    });

    test("uses defaults for optional fields", async () => {
      const { server } = createTestContext();

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "add-2",
            method: "tools/call",
            params: {
              name: "memory_add",
              arguments: {
                content: "A simple fact to remember",
              },
            },
          }),
        ),
      );

      const parsed = parseToolResult<{ type: string }>(response);
      expect(parsed.type).toBe("fact");
    });
  });

  describe("memory_list", () => {
    test("lists memories with type filter", async () => {
      const { server, store } = createTestContext();

      // Add mixed memories
      store.create({ type: "fact", layer: "long_term", content: "Fact one", confidence: 0.9, source: "test" });
      store.create({ type: "preference", layer: "long_term", content: "Pref one", confidence: 0.8, source: "test" });
      store.create({ type: "fact", layer: "long_term", content: "Fact two", confidence: 0.7, source: "test" });

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "list-1",
            method: "tools/call",
            params: {
              name: "memory_list",
              arguments: { type: "fact" },
            },
          }),
        ),
      );

      const parsed = parseToolResult<Array<{ type: string }>>(response);
      expect(parsed).toHaveLength(2);
      for (const m of parsed) {
        expect(m.type).toBe("fact");
      }
    });

    test("respects limit parameter", async () => {
      const { server, store } = createTestContext();

      for (let i = 0; i < 5; i++) {
        store.create({
          type: "fact",
          layer: "long_term",
          content: `Memory number ${i}`,
          confidence: 0.9,
          source: "test",
        });
      }

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "list-2",
            method: "tools/call",
            params: {
              name: "memory_list",
              arguments: { limit: 3 },
            },
          }),
        ),
      );

      const parsed = parseToolResult<unknown[]>(response);
      expect(parsed).toHaveLength(3);
    });
  });

  describe("kg_query", () => {
    test("returns entities matching name prefix", async () => {
      const { server, kgEntities } = createTestContext();

      // Add test entities
      kgEntities.create({
        name: "TypeScript",
        type: "technology",
        attributes: { category: "language" },
      });
      kgEntities.create({
        name: "Tailscale",
        type: "technology",
        attributes: { category: "networking" },
      });
      kgEntities.create({
        name: "Manuel",
        type: "person",
        attributes: {},
      });

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "kg-1",
            method: "tools/call",
            params: {
              name: "kg_query",
              arguments: { entity_name: "Type" },
            },
          }),
        ),
      );

      const parsed = parseToolResult<{ entities: Array<{ name: string }> }>(response);
      expect(parsed.entities.length).toBeGreaterThan(0);
      expect(parsed.entities[0]!.name).toBe("TypeScript");
    });

    test("filters entities by type", async () => {
      const { server, kgEntities } = createTestContext();

      kgEntities.create({ name: "TypeScript", type: "technology", attributes: {} });
      kgEntities.create({ name: "Manuel", type: "person", attributes: {} });

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "kg-2",
            method: "tools/call",
            params: {
              name: "kg_query",
              arguments: { entity_type: "person" },
            },
          }),
        ),
      );

      const parsed = parseToolResult<{ entities: Array<{ name: string; type: string }> }>(response);
      expect(parsed.entities).toHaveLength(1);
      expect(parsed.entities[0]!.name).toBe("Manuel");
      expect(parsed.entities[0]!.type).toBe("person");
    });

    test("returns triples for matching entities", async () => {
      const { server, kgEntities, kgRelations } = createTestContext();

      const e1 = kgEntities.create({ name: "Manuel", type: "person", attributes: {} });
      const e2 = kgEntities.create({ name: "TypeScript", type: "technology", attributes: {} });
      if (!e1.ok || !e2.ok) throw new Error("Entity creation failed");

      kgRelations.create({
        sourceId: e1.value.id,
        targetId: e2.value.id,
        type: "uses",
        confidence: 0.95,
        source: "test",
      });

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "kg-3",
            method: "tools/call",
            params: {
              name: "kg_query",
              arguments: { entity_name: "Manuel" },
            },
          }),
        ),
      );

      const parsed = parseToolResult<{
        entities: Array<{ name: string }>;
        triples: Array<{ subject: string; predicate: string; object: string }>;
      }>(response);
      expect(parsed.entities.length).toBeGreaterThan(0);
      expect(parsed.triples.length).toBeGreaterThan(0);
      expect(parsed.triples[0]!.predicate).toBe("uses");
    });
  });

  describe("resources/list", () => {
    test("lists the stats resource", async () => {
      const { server } = createTestContext();

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "res-list-1",
            method: "resources/list",
          }),
        ),
      );

      const result = response.result as { resources: Array<{ uri: string; name: string }> };
      expect(result.resources).toHaveLength(1);
      expect(result.resources[0]!.uri).toBe("memory://stats");
    });
  });

  describe("resources/read (memory://stats)", () => {
    test("returns memory and KG statistics", async () => {
      const { server, store, kgEntities } = createTestContext();

      // Add some test data
      store.create({ type: "fact", layer: "long_term", content: "Fact 1", confidence: 0.9, source: "test" });
      store.create({ type: "preference", layer: "long_term", content: "Pref 1", confidence: 0.8, source: "test" });
      kgEntities.create({ name: "TypeScript", type: "technology", attributes: {} });

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "stats-1",
            method: "resources/read",
            params: { uri: "memory://stats" },
          }),
        ),
      );

      const result = response.result as {
        contents: Array<{ uri: string; mimeType: string; text: string }>;
      };
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0]!.uri).toBe("memory://stats");

      const stats = JSON.parse(result.contents[0]!.text) as {
        totalMemories: number;
        byType: Record<string, number>;
        knowledgeGraph: { entities: number; relations: number };
      };
      expect(stats.totalMemories).toBe(2);
      expect(stats.byType.fact).toBe(1);
      expect(stats.byType.preference).toBe(1);
      expect(stats.knowledgeGraph.entities).toBe(1);
    });
  });

  describe("error handling", () => {
    test("rejects invalid JSON", async () => {
      const { server } = createTestContext();
      const response = await captureOutput<JsonRpcResult>(() => server.handleLine("not valid json"));

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32700);
    });

    test("rejects unknown method", async () => {
      const { server } = createTestContext();
      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "err-1",
            method: "nonexistent/method",
          }),
        ),
      );

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
    });

    test("rejects unknown tool", async () => {
      const { server } = createTestContext();
      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "err-2",
            method: "tools/call",
            params: { name: "nonexistent_tool", arguments: {} },
          }),
        ),
      );

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
    });

    test("responds to ping", async () => {
      const { server } = createTestContext();
      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "ping-1",
            method: "ping",
          }),
        ),
      );

      expect(response.id).toBe("ping-1");
      expect(response.result).toBeDefined();
      expect(response.error).toBeUndefined();
    });
  });

  describe("kg_query without KG stores", () => {
    test("returns error when KG is not available", async () => {
      const db = createTestDb();
      const logger = createSilentLogger();
      const store = new MemoryStore(db, logger);
      const server = new MemoryMcpServer({
        store,
        search: null,
        kgEntities: null,
        kgRelations: null,
        logger,
      });

      const response = await captureOutput<JsonRpcResult>(() =>
        server.handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "kg-no-store",
            method: "tools/call",
            params: {
              name: "kg_query",
              arguments: { entity_name: "test" },
            },
          }),
        ),
      );

      const result = response.result as { content: Array<{ text: string }>; isError: boolean };
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("not available");
    });
  });
});
