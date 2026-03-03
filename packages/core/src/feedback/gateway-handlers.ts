/**
 * Gateway RPC handler registration for the feedback module.
 *
 * Registers `feedback.submit` and `feedback.list` JSON-RPC methods on the
 * gateway server. Keeps the gateway server decoupled from the FeedbackStore
 * by wiring them together externally.
 */

import { z } from "zod";
import type { GatewayServer } from "../gateway/server.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { FeedbackStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Zod schemas for RPC validation
// ---------------------------------------------------------------------------

const FeedbackSubmitParamsSchema = z.object({
  sessionId: z.string().min(1).max(256),
  messageId: z.string().max(256).optional(),
  rating: z.number().int().min(1).max(5),
  channel: z.string().min(1).max(64),
  comment: z.string().max(2000).optional(),
});

const FeedbackListParamsSchema = z.object({
  sessionId: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  since: z.number().int().min(0).optional(),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register feedback-related RPC handlers on the gateway server.
 * Should be called during daemon initialization after both the gateway
 * and feedback store are ready.
 */
export function registerFeedbackHandlers(deps: {
  gateway: GatewayServer;
  feedbackStore: FeedbackStore;
  eventBus: EventBus;
  logger: Logger;
}): void {
  const { gateway, feedbackStore, eventBus, logger } = deps;
  const log = logger.child("feedback-rpc");

  // feedback.submit: record a user rating for a response
  gateway.registerHandler("feedback.submit", async (params) => {
    const parsed = FeedbackSubmitParamsSchema.safeParse(params);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i: z.ZodIssue) => i.message).join(", ");
      throw new Error(`Invalid feedback.submit params: ${issues}`);
    }

    const result = feedbackStore.submit(parsed.data);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    // Emit event for downstream processing (confidence adjustment, dashboards)
    eventBus.publish(
      "user:feedback",
      {
        feedbackId: result.value.id,
        sessionId: result.value.sessionId,
        messageId: result.value.messageId,
        rating: result.value.rating,
        channel: result.value.channel,
      },
      { source: "gateway", priority: "normal" },
    );

    log.info("submit", `Feedback submitted: rating=${result.value.rating}`, {
      feedbackId: result.value.id,
      sessionId: result.value.sessionId,
      channel: result.value.channel,
    });

    return result.value;
  });

  // feedback.list: query feedback entries
  gateway.registerHandler("feedback.list", async (params) => {
    const parsed = FeedbackListParamsSchema.safeParse(params);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i: z.ZodIssue) => i.message).join(", ");
      throw new Error(`Invalid feedback.list params: ${issues}`);
    }

    const result = feedbackStore.list(parsed.data);
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    return { entries: result.value };
  });

  log.debug("register", "Feedback RPC handlers registered on gateway");
}
