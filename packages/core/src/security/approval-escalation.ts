/**
 * Approval escalation logic and policy helpers.
 *
 * Extracted from approval-manager.ts to keep it under 300 lines.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  ApprovalStatus,
  EidolonError,
  Result,
  SecurityConfig,
  TimeoutAction,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";

/** Default max escalation depth when not specified in policy. */
const DEFAULT_MAX_ESCALATIONS = 3;

// ---------------------------------------------------------------------------
// Escalation policy helpers
// ---------------------------------------------------------------------------

/** Get the timeout in ms for a given escalation level. */
export function getTimeoutForLevel(config: SecurityConfig, level: number): number {
  const chain = config.approval.escalation;
  if (chain.length > 0 && level < chain.length) {
    return chain[level]?.timeoutMs ?? config.approval.timeout;
  }
  return config.approval.timeout;
}

/** Get the timeout action for a given escalation level. */
export function getTimeoutAction(config: SecurityConfig, level: number): TimeoutAction {
  const chain = config.approval.escalation;
  if (chain.length > 0 && level < chain.length) {
    return chain[level]?.action ?? (config.approval.defaultAction === "allow" ? "approve" : "deny");
  }
  // When level is beyond the chain, check if the last chain entry was an
  // escalation.  If so, return "escalate" so the escalate() method can
  // evaluate the maxEscalations guard.
  if (chain.length > 0) {
    const lastEntry = chain[chain.length - 1];
    if (!lastEntry) return config.approval.defaultAction === "allow" ? "approve" : "deny";
    if (lastEntry.action === "escalate") return "escalate";
  }
  return config.approval.defaultAction === "allow" ? "approve" : "deny";
}

/** Get the channel to escalate to for a given level. */
export function getEscalateToChannel(config: SecurityConfig, level: number): string | undefined {
  const chain = config.approval.escalation;
  if (chain.length > 0 && level < chain.length) {
    return chain[level]?.escalateTo;
  }
  return undefined;
}

/** Get the max escalations for a given level. */
export function getMaxEscalations(config: SecurityConfig, level: number): number {
  const chain = config.approval.escalation;
  if (chain.length > 0 && level < chain.length) {
    return chain[level]?.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
  }
  if (chain.length > 0) {
    return chain[chain.length - 1]?.maxEscalations ?? DEFAULT_MAX_ESCALATIONS;
  }
  return DEFAULT_MAX_ESCALATIONS;
}

// ---------------------------------------------------------------------------
// Escalation execution
// ---------------------------------------------------------------------------

export interface EscalateDeps {
  readonly db: Database;
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly config: SecurityConfig;
}

/**
 * Escalate a request to the next channel in the escalation chain.
 * If max escalations reached, applies the default action.
 */
export function escalateRequest(request: ApprovalRequest, deps: EscalateDeps): Result<ApprovalRequest, EidolonError> {
  const nextLevel = request.escalationLevel + 1;
  const maxEsc = getMaxEscalations(deps.config, request.escalationLevel);

  if (nextLevel > maxEsc) {
    return resolveMaxEscalation(request, deps);
  }

  return createEscalatedRequest(request, nextLevel, deps);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveMaxEscalation(request: ApprovalRequest, deps: EscalateDeps): Result<ApprovalRequest, EidolonError> {
  const defaultAction = deps.config.approval.defaultAction;
  const resolvedStatus: ApprovalStatus = defaultAction === "allow" ? "approved" : "denied";
  // Safety: never auto-approve dangerous actions (same guard as resolveTimeout)
  const finalStatus: ApprovalStatus =
    resolvedStatus === "approved" && request.level === "dangerous" ? "denied" : resolvedStatus;
  const now = Date.now();

  try {
    deps.db
      .query("UPDATE approval_requests SET status = ?, responded_by = ?, responded_at = ? WHERE id = ?")
      .run(finalStatus, `auto:max_escalation:${finalStatus}`, now, request.id);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to resolve max-escalated request ${request.id}`, cause));
  }

  const maxEsc = getMaxEscalations(deps.config, request.escalationLevel);
  deps.logger.warn("escalate", `Approval ${request.id} reached max escalations (${maxEsc}), auto-${finalStatus}`);

  return Ok({
    ...request,
    status: finalStatus,
    respondedBy: `auto:max_escalation:${finalStatus}`,
    respondedAt: now,
  });
}

function createEscalatedRequest(
  request: ApprovalRequest,
  nextLevel: number,
  deps: EscalateDeps,
): Result<ApprovalRequest, EidolonError> {
  const escalateTo = getEscalateToChannel(deps.config, request.escalationLevel);
  const newChannel = escalateTo ?? request.channel;
  const newTimeoutMs = getTimeoutForLevel(deps.config, nextLevel);
  const now = Date.now();
  const newTimeoutAt = now + newTimeoutMs;

  try {
    deps.db
      .query("UPDATE approval_requests SET status = 'escalated', responded_by = ?, responded_at = ? WHERE id = ?")
      .run("auto:escalated", now, request.id);
  } catch (cause) {
    return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to mark request ${request.id} as escalated`, cause));
  }

  const newId = randomUUID();
  const metadataJson = JSON.stringify({
    ...(request.metadata ?? {}),
    originalRequestId: request.id,
    escalatedFrom: request.channel,
  });

  try {
    deps.db
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

  deps.eventBus.publish(
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

  deps.logger.info("escalate", `Approval ${request.id} escalated to ${newChannel} (level ${nextLevel})`, {
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
