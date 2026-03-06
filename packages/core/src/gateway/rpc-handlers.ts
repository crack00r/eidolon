/**
 * Core RPC method handler factories for the Gateway server.
 *
 * Each function returns a MethodHandler that can be registered on a GatewayServer.
 * Handlers validate params with Zod, delegate to the appropriate module,
 * and return structured results.
 */

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { MemoryType, MemoryLayer } from "@eidolon/protocol";
import { z } from "zod";
import type { HealthChecker } from "../health/checker.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { MemorySearch } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { MethodHandler } from "./server.ts";

// ---------------------------------------------------------------------------
// Zod schemas for RPC method params
// ---------------------------------------------------------------------------

const ChatSendParamsSchema = z.object({
  text: z.string().min(1).max(100_000),
  channelId: z.string().min(1).max(64).optional(),
});

const ChatStreamParamsSchema = z.object({
  text: z.string().min(1).max(100_000),
  channelId: z.string().min(1).max(64).optional(),
});

const MemorySearchParamsSchema = z.object({
  query: z.string().min(1).max(4096),
  limit: z.number().int().min(1).max(100).optional(),
  types: z.array(z.string()).max(10).optional(),
  layers: z.array(z.string()).max(10).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  includeGraph: z.boolean().optional(),
});

const MemoryDeleteParamsSchema = z.object({
  id: z.string().min(1).max(256),
});

const SessionListParamsSchema = z.object({
  status: z.enum(["all", "running", "paused", "completed", "failed"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const SessionInfoParamsSchema = z.object({
  sessionId: z.string().min(1).max(256),
});

const LearningListParamsSchema = z.object({
  status: z.enum(["all", "new", "evaluated", "approved", "rejected", "implemented"]).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const LearningApproveParamsSchema = z.object({
  discoveryId: z.string().min(1).max(256),
});

const LearningRejectParamsSchema = z.object({
  discoveryId: z.string().min(1).max(256),
  reason: z.string().max(1024).optional(),
});

const VoiceStartParamsSchema = z.object({
  codec: z.enum(["opus", "pcm"]).optional(),
  sampleRate: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// RPC validation error (mirrors the one in server.ts)
// ---------------------------------------------------------------------------

class RpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcValidationError";
  }
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

/** Dependencies required by core RPC handlers. */
export interface CoreRpcDeps {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly operationalDb?: Database;
  readonly memorySearch?: MemorySearch;
  readonly memoryStore?: MemoryStore;
  readonly healthChecker?: HealthChecker;
  readonly startTime: number;
}

/**
 * Create the chat.send handler.
 * Routes a user message through the EventBus as a user:message event.
 */
export function createChatSendHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params, clientId) => {
    const parsed = ChatSendParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid chat.send params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { text, channelId } = parsed.data;
    const messageId = randomUUID();

    deps.eventBus.publish(
      "user:message",
      {
        messageId,
        channelId: channelId ?? "gateway",
        userId: clientId,
        text,
      },
      { source: "gateway", priority: "critical" },
    );

    deps.logger.info("chat.send", `Client ${clientId} sent message (${text.length} chars)`);

    return { messageId, status: "queued" };
  };
}

/**
 * Create the chat.stream handler.
 * Routes a user message and returns immediately; responses are pushed
 * via WebSocket push events as they stream in from the cognitive loop.
 */
export function createChatStreamHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params, clientId) => {
    const parsed = ChatStreamParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid chat.stream params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { text, channelId } = parsed.data;
    const messageId = randomUUID();
    const streamId = randomUUID();

    deps.eventBus.publish(
      "user:message",
      {
        messageId,
        streamId,
        channelId: channelId ?? "gateway",
        userId: clientId,
        text,
        streaming: true,
      },
      { source: "gateway", priority: "critical" },
    );

    deps.logger.info("chat.stream", `Client ${clientId} started streaming chat (${text.length} chars)`);

    return { messageId, streamId, status: "streaming" };
  };
}

/**
 * Create the memory.search handler.
 * Calls MemorySearch.search() with the provided query parameters.
 */
export function createMemorySearchHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params) => {
    if (!deps.memorySearch) {
      throw new RpcValidationError("Memory search is not available");
    }

    const parsed = MemorySearchParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid memory.search params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { query, limit, types, layers, minConfidence, includeGraph } = parsed.data;

    const result = await deps.memorySearch.search({
      text: query,
      limit,
      types: types as MemoryType[] | undefined,
      layers: layers as MemoryLayer[] | undefined,
      minConfidence,
      includeGraph,
    });

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    return {
      results: result.value.map((r) => ({
        id: r.memory.id,
        type: r.memory.type,
        layer: r.memory.layer,
        content: r.memory.content,
        confidence: r.memory.confidence,
        score: r.score,
        bm25Score: r.bm25Score,
        vectorScore: r.vectorScore,
        graphScore: r.graphScore,
        matchReason: r.matchReason,
        tags: r.memory.tags,
        createdAt: r.memory.createdAt,
        updatedAt: r.memory.updatedAt,
      })),
      total: result.value.length,
    };
  };
}

/**
 * Create the memory.delete handler.
 * Calls MemoryStore.delete() to remove a memory by ID.
 */
export function createMemoryDeleteHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params) => {
    if (!deps.memoryStore) {
      throw new RpcValidationError("Memory store is not available");
    }

    const parsed = MemoryDeleteParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid memory.delete params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const result = deps.memoryStore.delete(parsed.data.id);
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }

    deps.logger.info("memory.delete", `Deleted memory ${parsed.data.id}`);

    return { deleted: true, id: parsed.data.id };
  };
}

/**
 * Create the session.list handler.
 * Queries sessions from the operational database.
 */
export function createSessionListHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params) => {
    if (!deps.operationalDb) {
      throw new RpcValidationError("Operational database is not available");
    }

    const parsed = SessionListParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid session.list params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const status = parsed.data.status ?? "all";
    const limit = parsed.data.limit ?? 50;

    let sql = "SELECT id, type, status, claude_session_id, started_at, last_activity_at, completed_at, tokens_used, cost_usd, metadata FROM sessions";
    const queryParams: Array<string | number> = [];

    if (status !== "all") {
      sql += " WHERE status = ?";
      queryParams.push(status);
    }

    sql += " ORDER BY last_activity_at DESC LIMIT ?";
    queryParams.push(limit);

    const rows = deps.operationalDb.query(sql).all(...queryParams) as Array<Record<string, unknown>>;

    return {
      sessions: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        claudeSessionId: row.claude_session_id,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
        completedAt: row.completed_at,
        tokensUsed: row.tokens_used,
        costUsd: row.cost_usd,
      })),
      total: rows.length,
    };
  };
}

/**
 * Create the session.info handler.
 * Gets details for a single session by ID.
 */
export function createSessionInfoHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params) => {
    if (!deps.operationalDb) {
      throw new RpcValidationError("Operational database is not available");
    }

    const parsed = SessionInfoParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid session.info params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const row = deps.operationalDb
      .query(
        "SELECT id, type, status, claude_session_id, started_at, last_activity_at, completed_at, tokens_used, cost_usd, metadata FROM sessions WHERE id = ?",
      )
      .get(parsed.data.sessionId) as Record<string, unknown> | null;

    if (!row) {
      throw new RpcValidationError(`Session not found: ${parsed.data.sessionId}`);
    }

    return {
      session: {
        id: row.id,
        type: row.type,
        status: row.status,
        claudeSessionId: row.claude_session_id,
        startedAt: row.started_at,
        lastActivityAt: row.last_activity_at,
        completedAt: row.completed_at,
        tokensUsed: row.tokens_used,
        costUsd: row.cost_usd,
      },
    };
  };
}

/**
 * Create the learning.list handler.
 * Queries discoveries from the operational database.
 */
export function createLearningListHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params) => {
    if (!deps.operationalDb) {
      throw new RpcValidationError("Operational database is not available");
    }

    const parsed = LearningListParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid learning.list params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const status = parsed.data.status ?? "all";
    const limit = parsed.data.limit ?? 50;

    let sql = "SELECT id, source_type, url, title, content, relevance_score, safety_level, status, implementation_branch, created_at, evaluated_at, implemented_at FROM discoveries";
    const queryParams: Array<string | number> = [];

    if (status !== "all") {
      sql += " WHERE status = ?";
      queryParams.push(status);
    }

    sql += " ORDER BY created_at DESC LIMIT ?";
    queryParams.push(limit);

    const rows = deps.operationalDb.query(sql).all(...queryParams) as Array<Record<string, unknown>>;

    return {
      discoveries: rows.map((row) => ({
        id: row.id,
        sourceType: row.source_type,
        url: row.url,
        title: row.title,
        relevanceScore: row.relevance_score,
        safetyLevel: row.safety_level,
        status: row.status,
        implementationBranch: row.implementation_branch,
        createdAt: row.created_at,
        evaluatedAt: row.evaluated_at,
        implementedAt: row.implemented_at,
      })),
      total: rows.length,
    };
  };
}

/**
 * Create the learning.approve handler.
 * Updates discovery status to 'approved' and emits learning:approved event.
 */
export function createLearningApproveHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params, clientId) => {
    if (!deps.operationalDb) {
      throw new RpcValidationError("Operational database is not available");
    }

    const parsed = LearningApproveParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid learning.approve params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { discoveryId } = parsed.data;

    // Check discovery exists and is in a valid state
    const row = deps.operationalDb
      .query("SELECT id, status, title FROM discoveries WHERE id = ?")
      .get(discoveryId) as Record<string, unknown> | null;

    if (!row) {
      throw new RpcValidationError(`Discovery not found: ${discoveryId}`);
    }

    if (row.status !== "new" && row.status !== "evaluated") {
      throw new RpcValidationError(`Discovery ${discoveryId} cannot be approved (current status: ${String(row.status)})`);
    }

    // Update status
    deps.operationalDb
      .query("UPDATE discoveries SET status = 'approved', evaluated_at = ? WHERE id = ?")
      .run(Date.now(), discoveryId);

    // Emit learning:approved event
    deps.eventBus.publish(
      "learning:approved",
      { discoveryId, title: row.title, approvedBy: clientId },
      { source: "gateway", priority: "normal" },
    );

    deps.logger.info("learning.approve", `Client ${clientId} approved discovery ${discoveryId}`);

    return { approved: true, discoveryId };
  };
}

/**
 * Create the learning.reject handler.
 * Updates discovery status to 'rejected'.
 */
export function createLearningRejectHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params, clientId) => {
    if (!deps.operationalDb) {
      throw new RpcValidationError("Operational database is not available");
    }

    const parsed = LearningRejectParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid learning.reject params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { discoveryId, reason } = parsed.data;

    // Check discovery exists
    const row = deps.operationalDb
      .query("SELECT id, status FROM discoveries WHERE id = ?")
      .get(discoveryId) as Record<string, unknown> | null;

    if (!row) {
      throw new RpcValidationError(`Discovery not found: ${discoveryId}`);
    }

    if (row.status !== "new" && row.status !== "evaluated") {
      throw new RpcValidationError(`Discovery ${discoveryId} cannot be rejected (current status: ${String(row.status)})`);
    }

    deps.operationalDb
      .query("UPDATE discoveries SET status = 'rejected', evaluated_at = ? WHERE id = ?")
      .run(Date.now(), discoveryId);

    deps.eventBus.publish(
      "learning:rejected",
      { discoveryId, reason: reason ?? null, rejectedBy: clientId },
      { source: "gateway", priority: "normal" },
    );

    deps.logger.info("learning.reject", `Client ${clientId} rejected discovery ${discoveryId}`);

    return { rejected: true, discoveryId };
  };
}

/**
 * Create the system.status handler with real data.
 * Returns daemon status including uptime, memory count, and connection info.
 */
export function createSystemStatusHandler(deps: CoreRpcDeps): MethodHandler {
  return async () => {
    const uptimeMs = Date.now() - deps.startTime;

    let memoryCount = 0;
    if (deps.memoryStore) {
      const countResult = deps.memoryStore.count();
      if (countResult.ok) {
        memoryCount = countResult.value;
      }
    }

    let eventQueueDepth = 0;
    const pendingResult = deps.eventBus.pendingCount();
    if (pendingResult.ok) {
      eventQueueDepth = pendingResult.value;
    }

    return {
      state: "running",
      uptime: uptimeMs,
      memoryCount,
      eventQueueDepth,
      connectedClients: 0, // Will be overridden by server-level info
    };
  };
}

/**
 * Create the system.health handler with real health check data.
 */
export function createSystemHealthHandler(deps: CoreRpcDeps): MethodHandler {
  return async () => {
    const uptimeMs = Date.now() - deps.startTime;

    if (!deps.healthChecker) {
      return {
        status: "unknown",
        timestamp: Date.now(),
        uptimeMs,
        checks: [],
        note: "HealthChecker not available",
      };
    }

    const healthStatus = await deps.healthChecker.check();

    return {
      status: healthStatus.status,
      timestamp: healthStatus.timestamp,
      uptimeMs,
      checks: healthStatus.checks,
    };
  };
}

/**
 * Create the voice.start handler (placeholder).
 * Returns voice configuration for the client to use.
 */
export function createVoiceStartHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params, clientId) => {
    const parsed = VoiceStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid voice.start params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const sessionId = randomUUID();

    deps.logger.info("voice.start", `Client ${clientId} requested voice session ${sessionId}`);

    return {
      sessionId,
      status: "ready",
      config: {
        codec: parsed.data.codec ?? "opus",
        sampleRate: parsed.data.sampleRate ?? 24_000,
        channels: 1,
      },
    };
  };
}

/**
 * Create the voice.stop handler (placeholder).
 * Stops a voice session.
 */
export function createVoiceStopHandler(deps: CoreRpcDeps): MethodHandler {
  return async (_params, clientId) => {
    deps.logger.info("voice.stop", `Client ${clientId} stopped voice session`);
    return { stopped: true };
  };
}

// ---------------------------------------------------------------------------
// Bulk registration helper
// ---------------------------------------------------------------------------

/** All core RPC handlers keyed by method name. */
export function createCoreRpcHandlers(deps: CoreRpcDeps): ReadonlyMap<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>();

  handlers.set("chat.send", createChatSendHandler(deps));
  handlers.set("chat.stream", createChatStreamHandler(deps));
  handlers.set("memory.search", createMemorySearchHandler(deps));
  handlers.set("memory.delete", createMemoryDeleteHandler(deps));
  handlers.set("session.list", createSessionListHandler(deps));
  handlers.set("session.info", createSessionInfoHandler(deps));
  handlers.set("learning.list", createLearningListHandler(deps));
  handlers.set("learning.approve", createLearningApproveHandler(deps));
  handlers.set("learning.reject", createLearningRejectHandler(deps));
  handlers.set("system.status", createSystemStatusHandler(deps));
  handlers.set("system.health", createSystemHealthHandler(deps));
  handlers.set("voice.start", createVoiceStartHandler(deps));
  handlers.set("voice.stop", createVoiceStopHandler(deps));

  return handlers;
}
