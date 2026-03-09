/**
 * REST API route handlers for the Gateway server.
 *
 * Provides HTTP endpoints for:
 *   - GET  /api/conversations          -- list conversations
 *   - POST /api/conversations          -- create new conversation
 *   - GET  /api/conversations/:id/messages -- get messages
 *   - GET  /api/memories               -- list memories (paginated)
 *   - GET  /api/memories/search        -- search memories
 *   - GET  /api/learning/discoveries   -- list learning discoveries
 */

import { z } from "zod";
import type { ConversationSessionStore } from "../claude/session-store.ts";
import type { DiscoveryEngine } from "../learning/discovery.ts";
import type { Logger } from "../logging/logger.ts";
import type { MemorySearch } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";
import { SECURITY_HEADERS } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RestApiDeps {
  readonly logger: Logger;
  readonly memoryStore?: MemoryStore;
  readonly memorySearch?: MemorySearch;
  readonly conversationStore?: ConversationSessionStore;
  readonly discoveryEngine?: DiscoveryEngine;
  readonly authToken?: string;
  readonly isTls: boolean;
}

// ---------------------------------------------------------------------------
// Zod schemas for query params
// ---------------------------------------------------------------------------

const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const MemorySearchQuerySchema = z.object({
  q: z.string().min(1).max(4096),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const ConversationCreateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  channelId: z.string().min(1).max(64).optional(),
});

const DiscoveryListSchema = z.object({
  status: z.enum(["all", "new", "evaluated", "approved", "rejected", "implemented"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ---------------------------------------------------------------------------
// Main route dispatcher
// ---------------------------------------------------------------------------

/**
 * Handle REST API routes. Returns a Response if matched, or null if
 * the path doesn't match any API route.
 */
export function handleRestApiRoute(req: Request, url: URL, deps: RestApiDeps): Response | null {
  const path = url.pathname;

  // Auth check for all /api/ routes
  if (deps.authToken) {
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (token !== deps.authToken) {
      return jsonResponse({ error: "Unauthorized" }, 401, deps.isTls);
    }
  }

  // GET /api/conversations
  if (path === "/api/conversations" && req.method === "GET") {
    return handleListConversations(url, deps);
  }

  // POST /api/conversations
  if (path === "/api/conversations" && req.method === "POST") {
    return handleCreateConversation(req, deps);
  }

  // GET /api/conversations/:id/messages
  const convMessagesMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (convMessagesMatch && req.method === "GET") {
    const conversationId = convMessagesMatch[1];
    if (conversationId) {
      return handleGetConversationMessages(conversationId, url, deps);
    }
  }

  // GET /api/memories/search
  if (path === "/api/memories/search" && req.method === "GET") {
    return handleSearchMemories(url, deps);
  }

  // GET /api/memories
  if (path === "/api/memories" && req.method === "GET") {
    return handleListMemories(url, deps);
  }

  // GET /api/learning/discoveries
  if (path === "/api/learning/discoveries" && req.method === "GET") {
    return handleListDiscoveries(url, deps);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Conversation handlers
// ---------------------------------------------------------------------------

function handleListConversations(url: URL, deps: RestApiDeps): Response {
  if (!deps.conversationStore) {
    return jsonResponse({ error: "Conversation store not available" }, 503, deps.isTls);
  }

  const params = PaginationSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!params.success) {
    return jsonResponse({ error: "Invalid parameters", details: params.error.issues }, 400, deps.isTls);
  }

  const result = deps.conversationStore.list({
    limit: params.data.limit,
    offset: params.data.offset,
  });

  if (!result.ok) {
    return jsonResponse({ error: result.error.message }, 500, deps.isTls);
  }

  return jsonResponse({ conversations: result.value, total: result.value.length }, 200, deps.isTls);
}

function handleCreateConversation(req: Request, deps: RestApiDeps): Response {
  if (!deps.conversationStore) {
    return jsonResponse({ error: "Conversation store not available" }, 503, deps.isTls);
  }

  // Parse body synchronously is not possible with Request; return a promise-like response
  // Since Bun supports sync response from fetch, we handle async body parsing inline.
  // But handleRestApiRoute is sync. For POST we need async. Return null and let the
  // caller handle it. Instead, let's check if it's a simple JSON body.
  // Actually Bun fetch handlers can return Response | Promise<Response> | undefined.
  // We'll handle this differently -- see handleRestApiRouteAsync below.

  // For now return 501; the async variant is wired separately
  return jsonResponse({ error: "Use async handler" }, 501, deps.isTls);
}

function handleGetConversationMessages(conversationId: string, url: URL, deps: RestApiDeps): Response {
  if (!deps.conversationStore) {
    return jsonResponse({ error: "Conversation store not available" }, 503, deps.isTls);
  }

  const params = PaginationSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!params.success) {
    return jsonResponse({ error: "Invalid parameters", details: params.error.issues }, 400, deps.isTls);
  }

  const result = deps.conversationStore.getMessages(conversationId, {
    limit: params.data.limit,
    offset: params.data.offset,
  });

  if (!result.ok) {
    return jsonResponse({ error: result.error.message }, 500, deps.isTls);
  }

  return jsonResponse({ messages: result.value, total: result.value.length }, 200, deps.isTls);
}

// ---------------------------------------------------------------------------
// Memory handlers
// ---------------------------------------------------------------------------

function handleListMemories(url: URL, deps: RestApiDeps): Response {
  if (!deps.memoryStore) {
    return jsonResponse({ error: "Memory store not available" }, 503, deps.isTls);
  }

  const params = PaginationSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!params.success) {
    return jsonResponse({ error: "Invalid parameters", details: params.error.issues }, 400, deps.isTls);
  }

  const result = deps.memoryStore.list({
    limit: params.data.limit,
    offset: params.data.offset,
  });

  if (!result.ok) {
    return jsonResponse({ error: result.error.message }, 500, deps.isTls);
  }

  return jsonResponse({ memories: result.value, total: result.value.length }, 200, deps.isTls);
}

function handleSearchMemories(url: URL, deps: RestApiDeps): Response {
  if (!deps.memoryStore) {
    return jsonResponse({ error: "Memory search not available" }, 503, deps.isTls);
  }

  const queryParams = Object.fromEntries(url.searchParams);
  const parsed = MemorySearchQuerySchema.safeParse(queryParams);
  if (!parsed.success) {
    return jsonResponse({ error: "Invalid parameters", details: parsed.error.issues }, 400, deps.isTls);
  }

  // Use FTS5 text search (sync) for the sync handler.
  // The async handler (handleRestApiRouteAsync) uses hybrid vector+BM25 search.
  const result = deps.memoryStore.searchText(parsed.data.q, parsed.data.limit);
  if (!result.ok) {
    return jsonResponse({ error: result.error.message }, 500, deps.isTls);
  }

  return jsonResponse(
    {
      results: result.value.map((r) => ({
        memory: r.memory,
        rank: r.rank,
      })),
      total: result.value.length,
    },
    200,
    deps.isTls,
  );
}

// ---------------------------------------------------------------------------
// Learning handlers
// ---------------------------------------------------------------------------

function handleListDiscoveries(url: URL, deps: RestApiDeps): Response {
  if (!deps.discoveryEngine) {
    return jsonResponse({ error: "Discovery engine not available" }, 503, deps.isTls);
  }

  const queryParams = Object.fromEntries(url.searchParams);
  const parsed = DiscoveryListSchema.safeParse(queryParams);
  if (!parsed.success) {
    return jsonResponse({ error: "Invalid parameters", details: parsed.error.issues }, 400, deps.isTls);
  }

  const status = parsed.data.status ?? "all";
  const limit = parsed.data.limit ?? 50;

  if (status === "all") {
    // Get stats and recent discoveries
    const statsResult = deps.discoveryEngine.getStats();
    const recentResult = deps.discoveryEngine.listByStatus("new", limit);

    return jsonResponse(
      {
        stats: statsResult.ok ? statsResult.value : null,
        discoveries: recentResult.ok ? recentResult.value : [],
        total: recentResult.ok ? recentResult.value.length : 0,
      },
      200,
      deps.isTls,
    );
  }

  const validStatuses = ["new", "evaluated", "approved", "rejected", "implemented"] as const;
  type ValidStatus = (typeof validStatuses)[number];
  const safeStatus = validStatuses.includes(status as ValidStatus) ? (status as ValidStatus) : "new";

  const result = deps.discoveryEngine.listByStatus(safeStatus, limit);
  if (!result.ok) {
    return jsonResponse({ error: result.error.message }, 500, deps.isTls);
  }

  return jsonResponse({ discoveries: result.value, total: result.value.length }, 200, deps.isTls);
}

// ---------------------------------------------------------------------------
// Async route handler for POST endpoints
// ---------------------------------------------------------------------------

/**
 * Handle REST API routes that need async body parsing.
 * Returns a Response if matched, or null if not an API route.
 */
export async function handleRestApiRouteAsync(req: Request, url: URL, deps: RestApiDeps): Promise<Response | null> {
  const path = url.pathname;

  // Auth check
  if (deps.authToken) {
    const authHeader = req.headers.get("Authorization");
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (token !== deps.authToken) {
      return jsonResponse({ error: "Unauthorized" }, 401, deps.isTls);
    }
  }

  // POST /api/conversations
  if (path === "/api/conversations" && req.method === "POST") {
    if (!deps.conversationStore) {
      return jsonResponse({ error: "Conversation store not available" }, 503, deps.isTls);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body" }, 400, deps.isTls);
    }

    const parsed = ConversationCreateSchema.safeParse(body);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid parameters", details: parsed.error.issues }, 400, deps.isTls);
    }

    const result = deps.conversationStore.create({
      title: parsed.data.title,
      channelId: parsed.data.channelId ?? "gateway",
      userId: "default",
    });

    if (!result.ok) {
      return jsonResponse({ error: result.error.message }, 500, deps.isTls);
    }

    return jsonResponse({ conversation: result.value }, 201, deps.isTls);
  }

  // GET /api/memories/search (async version with full hybrid search)
  if (path === "/api/memories/search" && req.method === "GET" && deps.memorySearch) {
    const queryParams = Object.fromEntries(url.searchParams);
    const parsed = MemorySearchQuerySchema.safeParse(queryParams);
    if (!parsed.success) {
      return jsonResponse({ error: "Invalid parameters", details: parsed.error.issues }, 400, deps.isTls);
    }

    const result = await deps.memorySearch.search({
      text: parsed.data.q,
      limit: parsed.data.limit,
    });

    if (!result.ok) {
      return jsonResponse({ error: result.error.message }, 500, deps.isTls);
    }

    return jsonResponse(
      {
        results: result.value.map((r) => ({
          id: r.memory.id,
          type: r.memory.type,
          layer: r.memory.layer,
          content: r.memory.content,
          confidence: r.memory.confidence,
          score: r.score,
          tags: r.memory.tags,
          createdAt: r.memory.createdAt,
        })),
        total: result.value.length,
      },
      200,
      deps.isTls,
    );
  }

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status: number, isTls: boolean): Response {
  const headers: Record<string, string> = {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json",
  };
  if (isTls) {
    headers["Strict-Transport-Security"] = "max-age=31536000";
  }
  return new Response(JSON.stringify(data), { status, headers });
}
