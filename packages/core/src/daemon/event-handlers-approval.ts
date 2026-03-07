/**
 * User approval and feedback event handlers -- extracted from event-handlers-user.ts.
 *
 * Handles user:approval and user:feedback events in the cognitive loop.
 */

import type { Logger } from "../logging/logger.ts";
import type { EventHandlerResult } from "../loop/cognitive-loop.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Handler: user:approval
// ---------------------------------------------------------------------------

export function handleUserApproval(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): EventHandlerResult {
  try {
    const rawPayload = event.payload as Record<string, unknown>;
    const approvalId = typeof rawPayload.approvalId === "string" ? rawPayload.approvalId : undefined;
    const action = typeof rawPayload.action === "string" ? rawPayload.action : undefined;
    const respondedBy = typeof rawPayload.respondedBy === "string" ? rawPayload.respondedBy : "unknown";
    const reason = typeof rawPayload.reason === "string" ? rawPayload.reason : undefined;

    if (!approvalId || !action) {
      logger.warn("loop-handler", "Invalid user:approval payload: missing approvalId or action", {
        eventId: event.id,
      });
      return { success: false, tokensUsed: 0, error: "Invalid payload: missing approvalId or action" };
    }

    if (action !== "approve" && action !== "deny") {
      logger.warn("loop-handler", `Invalid approval action: ${action} (expected "approve" or "deny")`, {
        eventId: event.id,
        approvalId,
      });
      return { success: false, tokensUsed: 0, error: `Invalid approval action: ${action}` };
    }

    const approvalManager = modules.approvalManager;
    if (!approvalManager) {
      logger.warn("loop-handler", "Cannot process approval: ApprovalManager not initialized");
      return { success: false, tokensUsed: 0, error: "ApprovalManager not initialized" };
    }

    const approved = action === "approve";

    logger.info("loop-handler", `Processing approval response: ${action} for ${approvalId}`, {
      eventId: event.id,
      approvalId,
      action,
      respondedBy,
      reason,
    });

    const result = approvalManager.respond({
      requestId: approvalId,
      approved,
      respondedBy,
    });

    if (!result.ok) {
      logger.error("loop-handler", `Approval response failed: ${result.error.message}`, undefined, {
        approvalId,
        errorCode: result.error.code,
      });
      return { success: false, tokensUsed: 0, error: result.error.message };
    }

    // Log denied actions to audit trail
    if (!approved && modules.auditLogger) {
      modules.auditLogger.log({
        actor: respondedBy,
        action: "approval_denied",
        target: result.value.action,
        result: "denied",
        details: {
          approvalId,
          description: result.value.description,
          level: result.value.level,
          channel: result.value.channel,
          reason: reason ?? null,
        },
      });
    }

    // Also audit approved actions for completeness
    if (approved && modules.auditLogger) {
      modules.auditLogger.log({
        actor: respondedBy,
        action: "approval_granted",
        target: result.value.action,
        result: "success",
        details: {
          approvalId,
          description: result.value.description,
          level: result.value.level,
          channel: result.value.channel,
          reason: reason ?? null,
        },
      });
    }

    logger.info("loop-handler", `Approval ${approvalId} resolved: ${action}`, {
      approvalId,
      approvedAction: result.value.action,
      respondedBy,
    });

    return { success: true, tokensUsed: 0 };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `user:approval handler failed: ${errMsg}`);
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Handler: user:feedback
// ---------------------------------------------------------------------------

export function handleUserFeedback(
  _modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): EventHandlerResult {
  try {
    const rawPayload = event.payload as Record<string, unknown>;
    const sessionId = typeof rawPayload.sessionId === "string" ? rawPayload.sessionId : undefined;
    const rating = typeof rawPayload.rating === "number" ? rawPayload.rating : undefined;

    if (!sessionId || rating === undefined) {
      logger.warn("loop-handler", "Invalid user:feedback payload: missing sessionId or rating", {
        eventId: event.id,
      });
      return { success: false, tokensUsed: 0, error: "Invalid payload: missing sessionId or rating" };
    }

    logger.info("loop-handler", `User feedback received: session=${sessionId}, rating=${rating}`, {
      eventId: event.id,
      sessionId,
      rating,
    });

    // Confidence adjustment is handled by the EventBus subscription
    // (subscribeFeedbackConfidenceAdjustment) wired during daemon init.
    // This handler only needs to acknowledge the event in the cognitive loop.

    return { success: true, tokensUsed: 0 };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `user:feedback handler failed: ${errMsg}`);
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}
