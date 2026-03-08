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

import { z } from "zod";
import type { Logger } from "../logging/logger.ts";
import type { KGEntityStore } from "../memory/knowledge-graph/entities.ts";
import type { KGRelationStore } from "../memory/knowledge-graph/relations.ts";
import type { MemorySearch } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";
import {
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  type JsonRpcRequest,
  type JsonRpcResponse,
  RESOURCES,
  TOOLS,
} from "./memory-server-protocol.ts";
import { toolKgQuery, toolMemoryAdd, toolMemoryList, toolMemorySearch } from "./memory-server-tools.ts";

// ---------------------------------------------------------------------------
// Zod schemas for JSON-RPC tool call / resource read params
// ---------------------------------------------------------------------------

const ToolCallParamsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

const ResourceReadParamsSchema = z.object({
  uri: z.string(),
});

const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

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
  private reader: { cancel(reason?: unknown): Promise<void> } | null = null;

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
    this.reader = reader;
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (this.running) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

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
      this.reader = null;
      this.logger.info("start", "MCP Memory Server stopped");
    }
  }

  /** Stop the server. */
  stop(): void {
    this.running = false;
    if (this.reader) {
      this.reader.cancel().catch(() => {});
    }
  }

  /** Handle a single line of JSON-RPC input. */
  async handleLine(line: string): Promise<void> {
    let request: JsonRpcRequest;
    try {
      const raw: unknown = JSON.parse(line);
      const parsed = JsonRpcRequestSchema.safeParse(raw);
      if (!parsed.success) {
        this.sendError(null, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC request");
        return;
      }
      request = parsed.data;
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
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: "eidolon-memory", version: "0.1.0" },
        });
        break;

      case "notifications/initialized":
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
        if (request.method.startsWith("notifications/")) break;
        this.sendError(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
    }
  }

  // -----------------------------------------------------------------------
  // Tool handlers (delegated to memory-server-tools.ts)
  // -----------------------------------------------------------------------

  private async handleToolCall(id: string | number | null, params: Record<string, unknown>): Promise<void> {
    const parsed = ToolCallParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.sendError(id, JSON_RPC_INVALID_PARAMS, `Invalid tool call params: ${parsed.error.message}`);
      return;
    }
    const name = parsed.data.name;
    const args = parsed.data.arguments ?? {};

    let outcome: { ok: true; text: string } | { ok: false; error: string };

    switch (name) {
      case "memory_search":
        outcome = await toolMemorySearch(args, this.store, this.search);
        break;
      case "memory_add":
        outcome = toolMemoryAdd(args, this.store);
        break;
      case "memory_list":
        outcome = toolMemoryList(args, this.store);
        break;
      case "kg_query":
        outcome = toolKgQuery(args, this.kgEntities, this.kgRelations);
        break;
      default:
        this.sendError(id, JSON_RPC_METHOD_NOT_FOUND, `Unknown tool: ${name}`);
        return;
    }

    if (outcome.ok) {
      this.sendToolResult(id, outcome.text);
    } else if (outcome.error.startsWith("Invalid parameters:")) {
      this.sendError(id, JSON_RPC_INVALID_PARAMS, outcome.error);
    } else {
      this.sendToolError(id, outcome.error);
    }
  }

  // -----------------------------------------------------------------------
  // Resource handlers
  // -----------------------------------------------------------------------

  private async handleResourceRead(id: string | number | null, params: Record<string, unknown>): Promise<void> {
    const parsed = ResourceReadParamsSchema.safeParse(params);
    if (!parsed.success) {
      this.sendError(id, JSON_RPC_INVALID_PARAMS, `Invalid resource read params: ${parsed.error.message}`);
      return;
    }
    const uri = parsed.data.uri;

    if (uri === "memory://stats") {
      this.resourceStats(id);
    } else {
      this.sendError(id, -32602, `Unknown resource: ${uri}`);
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
      knowledgeGraph: { entities: entityCount, relations: relationCount },
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

  private sendToolResult(id: string | number | null, text: string): void {
    this.sendResult(id, { content: [{ type: "text", text }] });
  }

  private sendToolError(id: string | number | null, message: string): void {
    this.sendResult(id, { content: [{ type: "text", text: message }], isError: true });
  }

  private writeResponse(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    process.stdout.write(`${json}\n`);
  }
}
