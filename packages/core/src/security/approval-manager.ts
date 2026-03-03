/**
 * ApprovalManager -- manages approval requests with timeout policies and escalation chains.
 *
 * When an action requires approval, it creates an ApprovalRequest record in the database,
 * emits an "approval:requested" event, and waits for a response. If the request times out,
 * the configured timeout policy applies: auto-deny, auto-approve (safe actions only), or
 * escalate to another channel.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ActionLevel,
  ApprovalRequest,
  ApprovalStatus,
  EidolonError,
  EscalationPolicy,
  Result,
  SecurityConfig,
  TimeoutAction,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Default max escalation depth when not specified in policy. */
const DEFAULT_MAX_ESCALATIONS = 3;

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

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start periodic timeout checking. */
  start(): void {
    const intervalMs = this.config.approval.checkIntervalMs;
    this.checkTimer = setInterval(() => {
      this.checkTimeouts();
    }, intervalMs);
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

  // -------------------------------------------------------------------------
  // Request management
  // -------------------------------------------------------------------------

  /**
   * Create a new approval request and emit an event for it.
   * Returns the created ApprovalRequest record.
   */
  requestApproval(params: {
    action: string;
    level: ActionLevel;
    description: string;
    channel: string;
    metadata?: Record<string, unknown>;
  }): Result<ApprovalRequest, EidolonError> {
    const id = randomUUID();
    const now = Date.now();
    const timeoutMs = this.getTimeoutForLevel(0);
    const timeoutAt = now + timeoutMs;
    const metadataJson = JSON.stringify(params.metadata ?? {});

    try {
      this.db
        .query(
          `INSERT INTO approval_requests (id, action, level, description, requested_at, timeout_at, channel, status, escalation_level, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`,
        )
        .run(id, params.action, params.level, params.description, now, timeoutAt, params.channel, metadataJson);
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
      {
        requestId: id,
        action: params.action,
        level: params.level,
        description: params.description,
        channel: params.channel,
        timeoutAt,
      },
      { priority: "high", source: "approval-manager" },
    );

    this.logger.info(
      "request",
      `Approval requested: ${params.action} (level=${params.level}, timeout=${timeoutMs}ms)`,
      {
        id,
        channel: params.channel,
      },
    );

    return Ok(request);
  }

  /**
   * Respond to an approval request (approve or deny).
   */
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
      return Err(
        createError(
          ErrorCode.APPROVAL_ALREADY_RESOLVED,
          `Approval request ${params.requestId} already resolved (status: ${existing.value.status})`,
        ),
      );
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

    return Ok({
      ...existing.value,
      status: newStatus,
      respondedBy: params.respondedBy,
      respondedAt: now,
    });
  }

  // -------------------------------------------------------------------------
  // Timeout handling
  // -------------------------------------------------------------------------

  /**
   * Check all pending requests for timeouts and apply the configured policy.
   * Returns the number of requests that were timed out or escalated.
   */
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

    for (const row of timedOutRows) {
      const request = rowToRequest(row);
      const action = this.getTimeoutAction(request.escalationLevel);

      if (action === "escalate") {
        const escalateResult = this.escalate(request);
        if (escalateResult.ok) {
          processed++;
        }
      } else {
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
          continue;
        }

        this.eventBus.publish(
          "approval:timeout",
          {
            requestId: request.id,
            action: request.action,
            timeoutAction: finalStatus,
            escalationLevel: request.escalationLevel,
          },
          { priority: "normal", source: "approval-manager" },
        );

        this.logger.info("timeout", `Approval ${request.id} timed out, action: ${finalStatus}`, {
          action: request.action,
          escalationLevel: request.escalationLevel,
        });

        processed++;
      }
    }

    return processed;
  }

  // -------------------------------------------------------------------------
  // Escalation
  // -------------------------------------------------------------------------

  /**
   * Escalate a request to the next channel in the escalation chain.
   */
  private escalate(request: ApprovalRequest): Result<ApprovalRequest, EidolonError> {
    const nextLevel = request.escalationLevel + 1;
    const maxEscalations = this.getMaxEscalations(request.escalationLevel);

    if (nextLevel > maxEscalations) {
      // Max escalations reached -- apply default action
      const defaultAction = this.config.approval.defaultAction;
      const finalStatus: ApprovalStatus = defaultAction === "allow" ? "approved" : "denied";
      const now = Date.now();

      try {
        this.db
          .query("UPDATE approval_requests SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?")
          .run(finalStatus, `auto:max_escalation:${finalStatus}`, now, request.id);
      } catch (cause) {
        return Err(
          createError(ErrorCode.DB_QUERY_FAILED, `Failed to resolve max-escalated request ${request.id}`, cause),
        );
      }

      this.logger.warn(
        "escalate",
        `Approval ${request.id} reached max escalations (${maxEscalations}), auto-${finalStatus}`,
      );
      return Ok({
        ...request,
        status: finalStatus,
        respondedBy: `auto:max_escalation:${finalStatus}`,
        respondedAt: now,
      });
    }

    const escalateTo = this.getEscalateToChannel(request.escalationLevel);
    const newChannel = escalateTo ?? request.channel;
    const newTimeoutMs = this.getTimeoutForLevel(nextLevel);
    const now = Date.now();
    const newTimeoutAt = now + newTimeoutMs;

    try {
      this.db
        .query("UPDATE approval_requests SET status = 'escalated', responded_by = ?, responded_at = ? WHERE id = ?")
        .run("auto:escalated", now, request.id);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to mark request ${request.id} as escalated`, cause));
    }

    // Create a new request at the next escalation level
    const newId = randomUUID();
    const metadataJson = JSON.stringify({
      ...(request.metadata ?? {}),
      originalRequestId: request.id,
      escalatedFrom: request.channel,
    });

    try {
      this.db
        .query(
          `INSERT INTO approval_requests (id, action, level, description, requested_at, timeout_at, channel, status, escalation_level, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run(
          newId,
          request.action,
          request.level,
          request.description,
          now,
          newTimeoutAt,
          newChannel,
          nextLevel,
          metadataJson,
        );
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to create escalated request for ${request.id}`, cause));
    }

    this.eventBus.publish(
      "approval:escalated",
      {
        requestId: newId,
        action: request.action,
        fromChannel: request.channel,
        toChannel: newChannel,
        escalationLevel: nextLevel,
      },
      { priority: "high", source: "approval-manager" },
    );

    this.logger.info("escalate", `Approval ${request.id} escalated to ${newChannel} (level ${nextLevel})`, {
      newId,
      originalId: request.id,
    });

    return Ok({
      id: newId,
      action: request.action,
      level: request.level,
      description: request.description,
      requestedAt: now,
      timeoutAt: newTimeoutAt,
      channel: newChannel,
      status: "pending" as ApprovalStatus,
      escalationLevel: nextLevel,
      metadata: { ...(request.metadata ?? {}), originalRequestId: request.id, escalatedFrom: request.channel },
    });
  }

  // -------------------------------------------------------------------------
  // Query methods
  // -------------------------------------------------------------------------

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
    const status = params?.status ?? "pending";
    const limit = params?.limit ?? 50;

    try {
      const rows = this.db
        .query("SELECT * FROM approval_requests WHERE status = ? ORDER BY requested_at DESC LIMIT ?")
        .all(status, limit) as ApprovalRow[];
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

  // -------------------------------------------------------------------------
  // Escalation policy helpers
  // -------------------------------------------------------------------------

  /** Get the timeout in ms for a given escalation level. */
  private getTimeoutForLevel(level: number): number {
    const chain = this.config.approval.escalation;
    if (chain.length > 0 && level < chain.length) {
      return chain[level]!.timeoutMs;
    }
    return this.config.approval.timeout;
  }

  /** Get the timeout action for a given escalation level. */
  private getTimeoutAction(level: number): TimeoutAction {
    const chain = this.config.approval.escalation;
    if (chain.length > 0 && level < chain.length) {
      return chain[level]!.action;
    }
    // When level is beyond the chain, check if the last chain entry was an
    // escalation policy.  If so, we still return "escalate" so that the
    // escalate() method can evaluate the maxEscalations guard and apply the
    // default action when the limit has been reached.
    if (chain.length > 0) {
      const lastEntry = chain[chain.length - 1]!;
      if (lastEntry.action === "escalate") {
        return "escalate";
      }
    }
    return this.config.approval.defaultAction === "allow" ? "approve" : "deny";
  }

  /** Get the channel to escalate to for a given level. */
  private getEscalateToChannel(level: number): string | undefined {
    const chain = this.config.approval.escalation;
    if (chain.length > 0 && level < chain.length) {
      return chain[level]!.escalateTo;
    }
    return undefined;
  }

  /** Get the max escalations for a given level. */
  private getMaxEscalations(level: number): number {
    const chain = this.config.approval.escalation;
    if (chain.length > 0 && level < chain.length) {
      return chain[level]!.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
    }
    // When level is beyond the chain, inherit maxEscalations from the last entry
    if (chain.length > 0) {
      return chain[chain.length - 1]!.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
    }
    return DEFAULT_MAX_ESCALATIONS;
  }
}
