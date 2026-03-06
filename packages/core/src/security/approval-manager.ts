/**
 * ApprovalManager -- manages approval requests with timeout policies
 * and escalation chains.  Escalation logic lives in approval-escalation.ts.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ActionLevel,
  ApprovalRequest,
  ApprovalStatus,
  EidolonError,
  Result,
  SecurityConfig,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import {
  escalateRequest,
  getTimeoutAction,
  getTimeoutForLevel,
} from "./approval-escalation.ts";

// ---------------------------------------------------------------------------
// Database row type
// ---------------------------------------------------------------------------

interface ApprovalRow {
  id: string;
  action: string;
  level: string;
  description: string;
  requested_at: number;
  timeout_at: number;
  channel: string;
  status: string;
  responded_by: string | null;
  responded_at: number | null;
  escalation_level: number;
  metadata: string;
}

function rowToRequest(row: ApprovalRow): ApprovalRequest {
  let metadata: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(row.metadata);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      metadata = parsed as Record<string, unknown>;
    }
  } catch {
    // ignore corrupted metadata
  }

  return {
    id: row.id,
    action: row.action,
    level: row.level as ActionLevel,
    description: row.description,
    requestedAt: row.requested_at,
    timeoutAt: row.timeout_at,
    channel: row.channel,
    status: row.status as ApprovalStatus,
    respondedBy: row.responded_by ?? undefined,
    respondedAt: row.responded_at ?? undefined,
    escalationLevel: row.escalation_level,
    metadata,
  };
}

// ---------------------------------------------------------------------------
// ApprovalManager
// ---------------------------------------------------------------------------

export class ApprovalManager {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly config: SecurityConfig;
  private checkTimer: ReturnType<typeof setInterval> | undefined;

  constructor(deps: {
    db: Database;
    logger: Logger;
    eventBus: EventBus;
    config: SecurityConfig;
  }) {
    this.db = deps.db;
    this.logger = deps.logger.child("approval-manager");
    this.eventBus = deps.eventBus;
    this.config = deps.config;
  }

  /** Start periodic timeout checking. */
  start(): void {
    const intervalMs = this.config.approval.checkIntervalMs;
    this.checkTimer = setInterval(() => { this.checkTimeouts(); }, intervalMs);
    this.logger.info("start", `Approval timeout checker started (interval: ${intervalMs}ms)`);
  }

  /** Stop the periodic timeout checker. */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
      this.logger.info("stop", "Approval timeout checker stopped");
    }
  }

  /** Create a new approval request and emit an event for it. */
  requestApproval(params: {
    action: string;
    level: ActionLevel;
    description: string;
    channel: string;
    metadata?: Record<string, unknown>;
  }): Result<ApprovalRequest, EidolonError> {
    const id = randomUUID();
    const now = Date.now();
    const timeoutMs = getTimeoutForLevel(this.config, 0);
    const timeoutAt = now + timeoutMs;

    try {
      this.db
        .query(
          `INSERT INTO approval_requests (id, action, level, description, requested_at, timeout_at, channel, status, escalation_level, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
        )
        .run(id, params.action, params.level, params.description, now, timeoutAt, params.channel,
          JSON.stringify(params.metadata ?? {}));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to create approval request: ${params.action}`, cause));
    }

    const request: ApprovalRequest = {
      id,
      action: params.action,
      level: params.level,
      description: params.description,
      requestedAt: now,
      timeoutAt,
      channel: params.channel,
      status: "pending",
      escalationLevel: 0,
      metadata: params.metadata,
    };

    this.eventBus.publish(
      "approval:requested",
      { requestId: id, action: params.action, level: params.level,
        description: params.description, channel: params.channel, timeoutAt },
      { priority: "high", source: "approval-manager" },
    );

    this.logger.info("request",
      `Approval requested: ${params.action} (level=${params.level}, timeout=${timeoutMs}ms)`,
      { id, channel: params.channel });

    return Ok(request);
  }

  /** Respond to an approval request (approve or deny). */
  respond(params: {
    requestId: string;
    approved: boolean;
    respondedBy: string;
  }): Result<ApprovalRequest, EidolonError> {
    const existing = this.getById(params.requestId);
    if (!existing.ok) return existing;
    if (!existing.value) {
      return Err(createError(ErrorCode.APPROVAL_NOT_FOUND, `Approval request not found: ${params.requestId}`));
    }
    if (existing.value.status !== "pending") {
      return Err(createError(ErrorCode.APPROVAL_ALREADY_RESOLVED,
        `Approval request ${params.requestId} already resolved (status: ${existing.value.status})`));
    }

    const newStatus: ApprovalStatus = params.approved ? "approved" : "denied";
    const now = Date.now();

    try {
      this.db
        .query("UPDATE approval_requests SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?")
        .run(newStatus, params.respondedBy, now, params.requestId);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to respond to approval: ${params.requestId}`, cause));
    }

    this.logger.info("respond", `Approval ${params.requestId} ${newStatus} by ${params.respondedBy}`);
    return Ok({ ...existing.value, status: newStatus, respondedBy: params.respondedBy, respondedAt: now });
  }

  /** Check all pending requests for timeouts. Returns count processed. */
  checkTimeouts(): number {
    const now = Date.now();
    let processed = 0;

    let timedOutRows: ApprovalRow[];
    try {
      timedOutRows = this.db
        .query("SELECT * FROM approval_requests WHERE status = 'pending' AND timeout_at <= ?")
        .all(now) as ApprovalRow[];
    } catch (cause) {
      this.logger.error("checkTimeouts", "Failed to query timed-out requests", cause);
      return 0;
    }

    const deps = { db: this.db, logger: this.logger, eventBus: this.eventBus, config: this.config };
    for (const row of timedOutRows) {
      const request = rowToRequest(row);
      const action = getTimeoutAction(this.config, request.escalationLevel);

      if (action === "escalate") {
        if (escalateRequest(request, deps).ok) processed++;
      } else {
        processed += this.resolveTimeout(request, action, now);
      }
    }
    return processed;
  }

  /** Get an approval request by ID. */
  getById(id: string): Result<ApprovalRequest | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM approval_requests WHERE id = ?").get(id) as ApprovalRow | null;
      return Ok(row ? rowToRequest(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get approval request: ${id}`, cause));
    }
  }

  /** List approval requests by status. */
  list(params?: { status?: ApprovalStatus; limit?: number }): Result<ApprovalRequest[], EidolonError> {
    try {
      const rows = this.db
        .query("SELECT * FROM approval_requests WHERE status = ? ORDER BY requested_at DESC LIMIT ?")
        .all(params?.status ?? "pending", params?.limit ?? 50) as ApprovalRow[];
      return Ok(rows.map(rowToRequest));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list approval requests", cause));
    }
  }

  /** Count pending approval requests. */
  pendingCount(): Result<number, EidolonError> {
    try {
      const row = this.db.query("SELECT COUNT(*) as count FROM approval_requests WHERE status = 'pending'").get() as {
        count: number;
      };
      return Ok(row.count);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to count pending approvals", cause));
    }
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private resolveTimeout(request: ApprovalRequest, action: string, now: number): number {
    const resolvedStatus: ApprovalStatus = action === "approve" ? "approved" : "denied";
    // Safety: never auto-approve dangerous actions
    const finalStatus: ApprovalStatus =
      resolvedStatus === "approved" && request.level === "dangerous" ? "denied" : resolvedStatus;

    try {
      this.db
        .query("UPDATE approval_requests SET status = 'timeout', responded_by = ?, responded_at = ? WHERE id = ?")
        .run(`auto:${finalStatus}`, now, request.id);
    } catch (cause) {
      this.logger.error("checkTimeouts", `Failed to resolve timed-out request ${request.id}`, cause);
      return 0;
    }

    this.eventBus.publish(
      "approval:timeout",
      { requestId: request.id, action: request.action, timeoutAction: finalStatus,
        escalationLevel: request.escalationLevel },
      { priority: "normal", source: "approval-manager" },
    );
    this.logger.info("timeout", `Approval ${request.id} timed out, action: ${finalStatus}`,
      { action: request.action, escalationLevel: request.escalationLevel });
    return 1;
  }
}
