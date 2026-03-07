/**
 * MCP protocol types, constants, and tool/resource definitions.
 * Extracted from memory-server.ts to keep files under 300 lines.
 */

// ---------------------------------------------------------------------------
// MCP protocol types (JSON-RPC 2.0)
// ---------------------------------------------------------------------------

/** JSON-RPC 2.0 request. */
export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

/** JSON-RPC 2.0 success response. */
export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number | null;
  readonly result?: unknown;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** MCP tool definition. */
export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** MCP resource definition. */
export interface McpResourceDefinition {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const TOOLS: ReadonlyArray<McpToolDefinition> = [
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

export const RESOURCES: ReadonlyArray<McpResourceDefinition> = [
  {
    uri: "memory://stats",
    name: "Memory Statistics",
    description: "Memory count, types breakdown, and knowledge graph statistics",
    mimeType: "application/json",
  },
];
