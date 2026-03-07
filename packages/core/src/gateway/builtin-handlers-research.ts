/**
 * Research and miscellaneous RPC handler registrations for the Gateway server.
 * Extracted from builtin-handlers.ts to keep files under 300 lines.
 */

import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { BuiltinHandlerDeps } from "./builtin-handlers.ts";
import {
  ApprovalListParamsSchema,
  ApprovalRespondParamsSchema,
  AutomationCreateParamsSchema,
  AutomationDeleteParamsSchema,
  AutomationListParamsSchema,
  ResearchListParamsSchema,
  ResearchStartParamsSchema,
  ResearchStatusParamsSchema,
  RpcValidationError,
  SystemHealthParamsSchema,
} from "./rpc-schemas.ts";

// ---------------------------------------------------------------------------
// Research handlers
// ---------------------------------------------------------------------------

export function registerResearchHandlers(deps: BuiltinHandlerDeps): void {
  const { logger, eventBus, registerHandler } = deps;

  registerHandler("research.start", async (params, clientId) => {
    const parsed = ResearchStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid research.start params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { query, sources, maxSources, deliverTo } = parsed.data;

    logger.info("research.start", `Client ${clientId} requested research: "${query}"`);
    const researchId = randomUUID();
    eventBus.publish(
      "research:started",
      { researchId, query, sources: sources ?? [], maxSources: maxSources ?? 10, deliverTo },
      { source: "gateway", priority: "normal" },
    );
    return { researchId, status: "started" };
  });

  registerHandler("research.status", async (params) => {
    const parsed = ResearchStatusParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid research.status params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    return {
      researchId: parsed.data.researchId,
      status: "unknown",
      note: "Override this handler with actual research status retrieval",
    };
  });

  registerHandler("research.list", async (params) => {
    const parsed = ResearchListParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid research.list params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    return {
      results: [],
      limit: parsed.data.limit ?? 20,
      note: "Override this handler with actual research list retrieval",
    };
  });
}

// ---------------------------------------------------------------------------
// Misc handlers: profile, metrics, approval, automation, health
// ---------------------------------------------------------------------------

export function registerMiscHandlers(deps: BuiltinHandlerDeps): void {
  const { logger, eventBus, registerHandler, pushToSubscribers } = deps;

  registerHandler("profile.get", async () => {
    return { profile: null, note: "Override this handler with actual profile generation" };
  });

  registerHandler("metrics.rateLimits", async () => {
    if (!deps.rateLimitTracker) {
      return { accounts: [], note: "RateLimitTracker not configured" };
    }
    const statuses = deps.rateLimitTracker.getAllAccountStatuses();
    return { accounts: statuses };
  });

  registerHandler("approval.list", async (params) => {
    const parsed = ApprovalListParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid approval.list params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    return {
      items: [],
      status: parsed.data.status ?? "all",
      note: "Override this handler with actual approval list retrieval",
    };
  });

  registerHandler("approval.respond", async (params, clientId) => {
    const parsed = ApprovalRespondParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid approval.respond params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { approvalId, action, reason } = parsed.data;

    logger.info(
      "approval.respond",
      `Client ${clientId} ${action}d approval ${approvalId}${reason ? `: ${reason}` : ""}`,
    );
    eventBus.publish(
      "user:approval",
      { approvalId, action, reason: reason ?? null, respondedBy: clientId },
      { source: "gateway", priority: "high" },
    );

    const pushType = action === "approve" ? "push.approvalResolved" : "push.approvalResolved";
    pushToSubscribers(pushType, {
      approvalId,
      action,
      respondedBy: clientId,
      timestamp: Date.now(),
    });

    return { processed: true, approvalId, action };
  });

  registerHandler("automation.list", async (params) => {
    const parsed = AutomationListParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid automation.list params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    return {
      scenes: [],
      enabledOnly: parsed.data.enabledOnly ?? false,
      note: "Override this handler with actual automation list retrieval",
    };
  });

  registerHandler("automation.create", async (params, clientId) => {
    const parsed = AutomationCreateParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid automation.create params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { input, deliverTo } = parsed.data;

    logger.info("automation.create", `Client ${clientId} creating automation: "${input.slice(0, 80)}"`);
    const automationId = randomUUID();
    eventBus.publish(
      "system:config_changed",
      {
        action: "create_automation",
        automationId,
        input,
        deliverTo: deliverTo ?? null,
        requestedBy: clientId,
      },
      { source: "gateway", priority: "normal" },
    );
    return { created: true, automationId };
  });

  registerHandler("automation.delete", async (params, clientId) => {
    const parsed = AutomationDeleteParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid automation.delete params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { automationId } = parsed.data;

    logger.info("automation.delete", `Client ${clientId} deleting automation ${automationId}`);
    eventBus.publish(
      "system:config_changed",
      { action: "delete_automation", automationId, requestedBy: clientId },
      { source: "gateway", priority: "normal" },
    );
    return { deleted: true, automationId };
  });

  registerHandler("system.health", async (params) => {
    const parsed = SystemHealthParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid system.health params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const uptimeMs = deps.isRunning() ? Date.now() - deps.getStartTime() : 0;
    return {
      status: "healthy",
      timestamp: Date.now(),
      uptimeMs,
      checks: [],
      circuitBreakers: [],
      gpuWorkers: [],
      tokenUsage: { current: 0, limit: 0, series: [] },
      eventQueueDepth: 0,
      memoryStats: { totalMemories: 0, recentExtractions: 0 },
      errorRate: 0,
      includeMetrics: parsed.data.includeMetrics ?? false,
      note: "Override this handler with actual health aggregation",
    };
  });
}
