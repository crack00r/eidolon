/**
 * MCP Memory Server -- Expose Eidolon's memory engine as an MCP server.
 *
 * Implements the Model Context Protocol (JSON-RPC 2.0 over stdio) to allow
 * any MCP-compatible tool (Claude Code, Cline, Goose) to query Eidolon's
 * personal knowledge base.
 *
 * Tools exposed:
 *   - memory_search  -- hybrid search (BM25 + vector + graph + RRF)
 *   - memory_add     -- add a new memory
 *   - memory_list    -- list recent memories with optional type filter
 *   - kg_query       -- query knowledge graph entities and relations
 *
 * Resources exposed:
 *   - memory://stats  -- memory and KG statistics
 *
 * Transport: stdin/stdout (newline-delimited JSON-RPC 2.0)
 * Errors are logged to stderr to keep stdout clean for protocol messages.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, MemoryType, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";
import type { KGEntityStore } from "../memory/knowledge-graph/entities.ts";
import type { KGRelationStore } from "../memory/knowledge-graph/relations.ts";
import type { MemorySearch } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";

// ---------------------------------------------------------------------------
// MCP protocol types (JSON-RPC 2.0)
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request. */
interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 success response. */
interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** MCP tool definition. */
interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** MCP resource definition. */
interface McpResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

const JSON_RPC_PARSE_ERROR = -32700;
const JSON_RPC_INVALID_REQUEST = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;
const JSON_RPC_INVALID_PARAMS = -32602;
const JSON_RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Zod schemas for tool inputs
// ---------------------------------------------------------------------------

const MemorySearchInputSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(100).optional().default(10),
  type: z.enum(["fact", "preference", "decision", "episode", "skill", "relationship", "schema"]).optional(),
});

const MemoryAddInputSchema = z.object({
  content: z.string().min(1).max(50000),
  type: z.enum(["fact", "preference", "decision", "episode", "skill", "relationship", "schema"]).default("fact"),
  tags: z.array(z.string()).optional().default([]),
  source: z.string().optional().default("mcp"),
});

const MemoryListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
  type: z.enum(["fact", "preference", "decision", "episode", "skill", "relationship", "schema"]).optional(),
  offset: z.number().int().min(0).optional().default(0),
});

const KgQueryInputSchema = z.object({
  entity_name: z.string().min(1).max(500).optional(),
  entity_type: z.enum(["person", "technology", "device", "project", "concept", "place"]).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: ReadonlyArray<McpToolDefinition> = [
  {
    name: "memory_search",
    description:
      "Search Eidolon's memory using hybrid BM25 + vector + graph search with Reciprocal Rank Fusion. " +
      "Returns the most relevant memories matching the query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query text" },
        limit: { type: "number", description: "Max results (1-100, default 10)" },
        type: {
          type: "string",
          enum: ["fact", "preference", "decision", "episode", "skill", "relationship", "schema"],
          description: "Filter by memory type",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_add",
    description: "Add a new memory to Eidolon's knowledge base.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The memory content to store" },
        type: {
          type: "string",
          enum: ["fact", "preference", "decision", "episode", "skill", "relationship", "schema"],
          description: "Memory type (default: fact)",
        },
        tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        source: { type: "string", description: "Source identifier (default: mcp)" },
      },
      required: ["content"],
    },
  },
  {
    name: "memory_list",
    description: "List recent memories with optional type filter and pagination.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max results (1-100, default 20)" },
        type: {
          type: "string",
          enum: ["fact", "preference", "decision", "episode", "skill", "relationship", "schema"],
          description: "Filter by memory type",
        },
        offset: { type: "number", description: "Pagination offset (default 0)" },
      },
    },
  },
  {
    name: "kg_query",
    description:
      "Query the knowledge graph for entities and their relations. " +
      "Search by entity name or type, and returns matching entities with their triples.",
    inputSchema: {
      type: "object",
      properties: {
        entity_name: { type: "string", description: "Search for entities by name (prefix match)" },
        entity_type: {
          type: "string",
          enum: ["person", "technology", "device", "project", "concept", "place"],
          description: "Filter by entity type",
        },
        limit: { type: "number", description: "Max results (1-100, default 20)" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Resource definitions
// ---------------------------------------------------------------------------

const RESOURCES: ReadonlyArray<McpResourceDefinition> = [
  {
    uri: "memory://stats",
    name: "Memory Statistics",
    description: "Memory count, types breakdown, and knowledge graph statistics",
    mimeType: "application/json",
  },
];

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface MemoryMcpServerDeps {
  readonly store: MemoryStore;
  readonly search: MemorySearch | null;
  readonly kgEntities: KGEntityStore | null;
  readonly kgRelations: KGRelationStore | null;
  readonly logger: Logger;
}

// ---------------------------------------------------------------------------
// MemoryMcpServer
// ---------------------------------------------------------------------------

export class MemoryMcpServer {
  private readonly store: MemoryStore;
  private readonly search: MemorySearch | null;
  private readonly kgEntities: KGEntityStore | null;
  private readonly kgRelations: KGRelationStore | null;
  private readonly logger: Logger;
  private running = false;

  constructor(deps: MemoryMcpServerDeps) {
    this.store = deps.store;
    this.search = deps.search;
    this.kgEntities = deps.kgEntities;
    this.kgRelations = deps.kgRelations;
    this.logger = deps.logger.child("mcp-memory-server");
  }

  /** Start the MCP server on stdin/stdout. Blocks until stdin closes. */
  async start(): Promise<void> {
    this.running = true;
    this.logger.info("start", "MCP Memory Server starting on stdio");

    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        let newlineIdx = buffer.indexOf("\n");
        while (newlineIdx !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);

          if (line.length > 0) {
            await this.handleLine(line);
          }

          newlineIdx = buffer.indexOf("\n");
        }
      }
    } catch (error) {
      if (this.running) {
        this.logger.error("start", "Error reading stdin", error);
      }
    } finally {
      reader.releaseLock();
      this.logger.info("start", "MCP Memory Server stopped");
    }
  }

  /** Stop the server. */
  stop(): void {
    this.running = false;
  }

  /** Handle a single line of JSON-RPC input. */
  async handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || !("jsonrpc" in parsed)) {
        this.sendError(null, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC request");
        return;
      }
      request = parsed as JsonRpcRequest;
    } catch {
      this.sendError(null, JSON_RPC_PARSE_ERROR, "Parse error");
      return;
    }

    if (request.jsonrpc !== "2.0") {
      this.sendError(request.id ?? null, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC version");
      return;
    }

    try {
      await this.handleRequest(request);
    } catch (error) {
      this.logger.error("handleLine", "Unexpected error handling request", error);
      this.sendError(request.id ?? null, JSON_RPC_INTERNAL_ERROR, "Internal error");
    }
  }

  /** Route an MCP request to the appropriate handler. */
  async handleRequest(request: JsonRpcRequest): Promise<void> {
    const id = request.id ?? null;

    switch (request.method) {
      case "initialize":
        this.sendResult(id, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: "eidolon-memory",
            version: "0.1.0",
          },
        });
        break;

      case "notifications/initialized":
        // Client notification -- no response needed
        break;

      case "tools/list":
        this.sendResult(id, { tools: TOOLS });
        break;

      case "tools/call":
        await this.handleToolCall(id, request.params ?? {});
        break;

      case "resources/list":
        this.sendResult(id, { resources: RESOURCES });
        break;

      case "resources/read":
        await this.handleResourceRead(id, request.params ?? {});
        break;

      case "ping":
        this.sendResult(id, {});
        break;

      default:
        if (request.method.startsWith("notifications/")) {
          // Notifications don't need a response
          break;
        }
        this.sendError(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
    }
  }

  // -----------------------------------------------------------------------
  // Tool handlers
  // -----------------------------------------------------------------------

  private async handleToolCall(id: string | number | null, params: Record<string, unknown>): Promise<void> {
    const name = params.name as string | undefined;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    switch (name) {
      case "memory_search":
        await this.toolMemorySearch(id, args);
        break;
      case "memory_add":
        this.toolMemoryAdd(id, args);
        break;
      case "memory_list":
        this.toolMemoryList(id, args);
        break;
      case "kg_query":
        this.toolKgQuery(id, args);
        break;
      default:
        this.sendError(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
    }
  }

  private async toolMemorySearch(id: string | number | null, args: Record<string, unknown>): Promise<void> {
    const parsed = MemorySearchInputSchema.safeParse(args);
    if (!parsed.success) {
      this.sendError(id, JSON_RPC_INVALID_PARAMS, `Invalid parameters: ${parsed.error.message}`);
      return;
    }

    if (!this.search) {
      // Fall back to text-only search
      const textResult = this.store.searchText(parsed.data.query, parsed.data.limit);
      if (!textResult.ok) {
        this.sendToolError(id, `Search failed: ${textResult.error.message}`);
        return;
      }

      const results = textResult.value
        .filter((r) => !parsed.data.type || r.memory.type === parsed.data.type)
        .map((r) => ({
          id: r.memory.id,
          type: r.memory.type,
          content: r.memory.content,
          confidence: r.memory.confidence,
          tags: r.memory.tags,
          score: r.rank,
          createdAt: new Date(r.memory.createdAt).toISOString(),
        }));

      this.sendToolResult(id, JSON.stringify(results, null, 2));
      return;
    }

    const types = parsed.data.type ? [parsed.data.type as MemoryType] : undefined;
    const searchResult = await this.search.search({
      text: parsed.data.query,
      limit: parsed.data.limit,
      types,
    });

    if (!searchResult.ok) {
      this.sendToolError(id, `Search failed: ${searchResult.error.message}`);
      return;
    }

    const results = searchResult.value.map((r) => ({
      id: r.memory.id,
      type: r.memory.type,
      content: r.memory.content,
      confidence: r.memory.confidence,
      tags: r.memory.tags,
      score: r.score,
      matchReason: r.matchReason,
      createdAt: new Date(r.memory.createdAt).toISOString(),
    }));

    this.sendToolResult(id, JSON.stringify(results, null, 2));
  }

  private toolMemoryAdd(id: string | number | null, args: Record<string, unknown>): void {
    const parsed = MemoryAddInputSchema.safeParse(args);
    if (!parsed.success) {
      this.sendError(id, JSON_RPC_INVALID_PARAMS, `Invalid parameters: ${parsed.error.message}`);
      return;
    }

    const createResult = this.store.create({
      content: parsed.data.content,
      type: parsed.data.type as MemoryType,
      layer: "long_term",
      confidence: 0.8,
      source: parsed.data.source,
      tags: parsed.data.tags,
    });

    if (!createResult.ok) {
      this.sendToolError(id, `Failed to create memory: ${createResult.error.message}`);
      return;
    }

    this.sendToolResult(
      id,
      JSON.stringify(
        {
          id: createResult.value.id,
          content: createResult.value.content,
          type: createResult.value.type,
          createdAt: new Date(createResult.value.createdAt).toISOString(),
        },
        null,
        2,
      ),
    );
  }

  private toolMemoryList(id: string | number | null, args: Record<string, unknown>): void {
    const parsed = MemoryListInputSchema.safeParse(args);
    if (!parsed.success) {
      this.sendError(id, JSON_RPC_INVALID_PARAMS, `Invalid parameters: ${parsed.error.message}`);
      return;
    }

    const types = parsed.data.type ? [parsed.data.type as MemoryType] : undefined;
    const listResult = this.store.list({
      limit: parsed.data.limit,
      types,
      offset: parsed.data.offset,
      orderBy: "created_at",
      order: "desc",
    });

    if (!listResult.ok) {
      this.sendToolError(id, `Failed to list memories: ${listResult.error.message}`);
      return;
    }

    const results = listResult.value.map((m) => ({
      id: m.id,
      type: m.type,
      content: m.content,
      confidence: m.confidence,
      tags: m.tags,
      createdAt: new Date(m.createdAt).toISOString(),
    }));

    this.sendToolResult(id, JSON.stringify(results, null, 2));
  }

  private toolKgQuery(id: string | number | null, args: Record<string, unknown>): void {
    const parsed = KgQueryInputSchema.safeParse(args);
    if (!parsed.success) {
      this.sendError(id, JSON_RPC_INVALID_PARAMS, `Invalid parameters: ${parsed.error.message}`);
      return;
    }

    if (!this.kgEntities) {
      this.sendToolError(id, "Knowledge graph is not available");
      return;
    }

    // Find entities by name prefix or type
    let entityResult: Result<
      Array<{ id: string; name: string; type: string; attributes: Record<string, unknown>; createdAt: number }>,
      EidolonError
    >;

    if (parsed.data.entity_name) {
      entityResult = this.kgEntities.searchByName(parsed.data.entity_name, parsed.data.limit);
    } else if (parsed.data.entity_type) {
      entityResult = this.kgEntities.findByType(parsed.data.entity_type, parsed.data.limit);
    } else {
      entityResult = this.kgEntities.list({ limit: parsed.data.limit });
    }

    if (!entityResult.ok) {
      this.sendToolError(id, `KG query failed: ${entityResult.error.message}`);
      return;
    }

    const entities = entityResult.value;

    // Get triples for found entities
    let triples: Array<{ subject: string; predicate: string; object: string; confidence: number }> = [];
    if (this.kgRelations && entities.length > 0) {
      const entityIds = entities.map((e) => e.id);
      const triplesResult = this.kgRelations.getTriplesForEntities(entityIds, parsed.data.limit);
      if (triplesResult.ok) {
        triples = triplesResult.value;
      }
    }

    const result = {
      entities: entities.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        attributes: e.attributes,
        createdAt: new Date(e.createdAt).toISOString(),
      })),
      triples,
    };

    this.sendToolResult(id, JSON.stringify(result, null, 2));
  }

  // -----------------------------------------------------------------------
  // Resource handlers
  // -----------------------------------------------------------------------

  private async handleResourceRead(id: string | number | null, params: Record<string, unknown>): Promise<void> {
    const uri = params.uri as string | undefined;

    if (uri === "memory://stats") {
      this.resourceStats(id);
    } else {
      this.sendError(id, JSON_RPC_INVALID_PARAMS, `Unknown resource: ${uri}`);
    }
  }

  private resourceStats(id: string | number | null): void {
    const countResult = this.store.count();
    if (!countResult.ok) {
      this.sendError(id, JSON_RPC_INTERNAL_ERROR, `Failed to get stats: ${countResult.error.message}`);
      return;
    }

    const typeCounts: Record<string, number> = {};
    const memoryTypes = ["fact", "preference", "decision", "episode", "skill", "relationship", "schema"] as const;
    for (const t of memoryTypes) {
      const r = this.store.count([t]);
      if (r.ok) {
        typeCounts[t] = r.value;
      }
    }

    let entityCount = 0;
    let relationCount = 0;
    if (this.kgEntities) {
      const r = this.kgEntities.count();
      if (r.ok) entityCount = r.value;
    }
    if (this.kgRelations) {
      const r = this.kgRelations.count();
      if (r.ok) relationCount = r.value;
    }

    const stats = {
      totalMemories: countResult.value,
      byType: typeCounts,
      knowledgeGraph: {
        entities: entityCount,
        relations: relationCount,
      },
    };

    this.sendResult(id, {
      contents: [
        {
          uri: "memory://stats",
          mimeType: "application/json",
          text: JSON.stringify(stats, null, 2),
        },
      ],
    });
  }

  // -----------------------------------------------------------------------
  // JSON-RPC response helpers
  // -----------------------------------------------------------------------

  private sendResult(id: string | number | null, result: unknown): void {
    this.writeResponse({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.writeResponse({ jsonrpc: "2.0", id, error: { code, message, data } });
  }

  /** Send a tool result in the MCP content format. */
  private sendToolResult(id: string | number | null, text: string): void {
    this.sendResult(id, {
      content: [{ type: "text", text }],
    });
  }

  /** Send a tool error in the MCP content format. */
  private sendToolError(id: string | number | null, message: string): void {
    this.sendResult(id, {
      content: [{ type: "text", text: message }],
      isError: true,
    });
  }

  private writeResponse(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    process.stdout.write(`${json}\n`);
  }
}
