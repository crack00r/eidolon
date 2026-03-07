/**
 * Session, learning, and system RPC handler factories for the Gateway server.
 */

import { z } from "zod";
import type { CoreRpcDeps } from "./rpc-handlers.ts";
import type { MethodHandler } from "./server.ts";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

class RpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcValidationError";
  }
}

// ---------------------------------------------------------------------------
// Session handlers
// ---------------------------------------------------------------------------

/** Create the session.list handler. */
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

    let sql =
      "SELECT id, type, status, claude_session_id, started_at, last_activity_at, completed_at, tokens_used, cost_usd, metadata FROM sessions";
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

/** Create the session.info handler. */
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

// ---------------------------------------------------------------------------
// Learning handlers
// ---------------------------------------------------------------------------

/** Create the learning.list handler. */
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

    let sql =
      "SELECT id, source_type, url, title, content, relevance_score, safety_level, status, implementation_branch, created_at, evaluated_at, implemented_at FROM discoveries";
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

/** Create the learning.approve handler. */
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

    const row = deps.operationalDb
      .query("SELECT id, status, title FROM discoveries WHERE id = ?")
      .get(discoveryId) as Record<string, unknown> | null;

    if (!row) {
      throw new RpcValidationError(`Discovery not found: ${discoveryId}`);
    }

    if (row.status !== "new" && row.status !== "evaluated") {
      throw new RpcValidationError(
        `Discovery ${discoveryId} cannot be approved (current status: ${String(row.status)})`,
      );
    }

    deps.operationalDb
      .query("UPDATE discoveries SET status = 'approved', evaluated_at = ? WHERE id = ?")
      .run(Date.now(), discoveryId);

    deps.eventBus.publish(
      "learning:approved",
      { discoveryId, title: row.title, approvedBy: clientId },
      { source: "gateway", priority: "normal" },
    );

    deps.logger.info("learning.approve", `Client ${clientId} approved discovery ${discoveryId}`);

    return { approved: true, discoveryId };
  };
}

/** Create the learning.reject handler. */
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

    const row = deps.operationalDb.query("SELECT id, status FROM discoveries WHERE id = ?").get(discoveryId) as Record<
      string,
      unknown
    > | null;

    if (!row) {
      throw new RpcValidationError(`Discovery not found: ${discoveryId}`);
    }

    if (row.status !== "new" && row.status !== "evaluated") {
      throw new RpcValidationError(
        `Discovery ${discoveryId} cannot be rejected (current status: ${String(row.status)})`,
      );
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

// ---------------------------------------------------------------------------
// System handlers
// ---------------------------------------------------------------------------

/** Create the system.status handler. */
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

/** Create the system.health handler. */
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
