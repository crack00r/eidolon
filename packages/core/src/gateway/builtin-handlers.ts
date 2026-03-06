/**
 * Built-in RPC handler registrations for the Gateway server.
 *
 * Extracted from server.ts (P1-26) to keep the server module focused
 * on WebSocket lifecycle and connection management.
 */

import { randomUUID } from "node:crypto";
import type { ConnectedClientInfo, GatewayMethod, GatewayPushType } from "@eidolon/protocol";
import type { z } from "zod";
import type { CalendarManager } from "../calendar/index.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { RateLimitTracker } from "../metrics/rate-limits.ts";
import {
  ApprovalListParamsSchema,
  ApprovalRespondParamsSchema,
  AutomationCreateParamsSchema,
  AutomationDeleteParamsSchema,
  AutomationListParamsSchema,
  BrainGetLogParamsSchema,
  BrainTriggerActionParamsSchema,
  CalendarConflictsParamsSchema,
  CalendarCreateEventParamsSchema,
  CalendarGetUpcomingParamsSchema,
  CalendarListEventsParamsSchema,
  ClientExecuteParamsSchema,
  CommandResultParamsSchema,
  ErrorReportParamsSchema,
  ResearchListParamsSchema,
  ResearchStartParamsSchema,
  ResearchStatusParamsSchema,
  RpcValidationError,
  SystemHealthParamsSchema,
} from "./rpc-schemas.ts";
import type { ClientState, MethodHandler } from "./server-helpers.ts";
import { createPushEvent } from "./protocol.ts";

// ---------------------------------------------------------------------------
// Types for the registration context
// ---------------------------------------------------------------------------

export interface BuiltinHandlerDeps {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly rateLimitTracker: RateLimitTracker | undefined;
  readonly calendarManager: CalendarManager | undefined;
  /** Callback to register a handler on the server. */
  registerHandler: (method: GatewayMethod, handler: MethodHandler) => void;
  /** Callback to get client state by id. */
  getClient: (clientId: string) => ClientState | undefined;
  /** Callback to get all clients. */
  getClients: () => IterableIterator<ClientState>;
  /** Callback to get the number of connected clients. */
  getClientCount: () => number;
  /** Callback to check if a client is subscribed. */
  isSubscribed: (clientId: string) => boolean;
  /** Callback to add a status subscriber. */
  addSubscriber: (clientId: string) => void;
  /** Callback to push event to subscribers. */
  pushToSubscribers: (type: GatewayPushType, data: Record<string, unknown>) => void;
  /** Callback to send push to a specific target client WS. */
  sendToClient: (clientId: string, data: string) => boolean;
  /** Whether the server is currently running. */
  isRunning: () => boolean;
  /** Start time of the server. */
  getStartTime: () => number;
}

// ---------------------------------------------------------------------------
// Built-in handler registration
// ---------------------------------------------------------------------------

/** Register all built-in RPC handlers on the gateway. */
export function registerBuiltinHandlers(deps: BuiltinHandlerDeps): void {
  const { logger, eventBus, registerHandler, pushToSubscribers } = deps;

  // error.report / client.reportErrors: clients report errors back to the server
  const handleErrorReport: MethodHandler = async (params, clientId) => {
    const parsed = ErrorReportParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid error report params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { errors, clientInfo } = parsed.data;

    const client = deps.getClient(clientId);
    const platform = clientInfo?.platform ?? client?.platform ?? "unknown";
    const version = clientInfo?.version ?? client?.version ?? "unknown";

    for (const entry of errors) {
      logger.warn(
        "client-error",
        `[${platform}@${version}] ${String(entry.module ?? "unknown")}: ${String(entry.message ?? "")}`,
        {
          clientId,
          level: String(entry.level ?? "error"),
          timestamp: String(entry.timestamp ?? ""),
          ...(entry.data !== undefined ? { data: entry.data } : {}),
        },
      );
    }

    eventBus.publish(
      "gateway:client_error_report",
      { clientId, platform, version, errorCount: errors.length },
      { source: "gateway" },
    );

    return { received: errors.length };
  };

  registerHandler("error.report", handleErrorReport);
  registerHandler("client.reportErrors", handleErrorReport);

  // system.status
  registerHandler("system.status", async () => {
    const uptimeMs = deps.isRunning() ? Date.now() - deps.getStartTime() : 0;
    return {
      state: "running",
      energy: { current: 0, max: 100 },
      activeTasks: 0,
      memoryCount: 0,
      uptime: uptimeMs,
      connectedClients: deps.getClientCount(),
    };
  });

  // system.subscribe
  registerHandler("system.subscribe", async (_params, clientId) => {
    deps.addSubscriber(clientId);
    logger.debug("subscribe", `Client ${clientId} subscribed to status updates`);
    return { subscribed: true };
  });

  // -----------------------------------------------------------------------
  // Brain control handlers
  // -----------------------------------------------------------------------

  registerHandler("brain.pause", async (_params, clientId) => {
    logger.info("brain.pause", `Client ${clientId} requested cognitive loop pause`);
    eventBus.publish(
      "system:config_changed",
      { action: "pause", requestedBy: clientId },
      { source: "gateway", priority: "high" },
    );
    pushToSubscribers("push.stateChange", {
      previousState: "running",
      currentState: "paused",
      timestamp: Date.now(),
    });
    return { paused: true };
  });

  registerHandler("brain.resume", async (_params, clientId) => {
    logger.info("brain.resume", `Client ${clientId} requested cognitive loop resume`);
    eventBus.publish(
      "system:config_changed",
      { action: "resume", requestedBy: clientId },
      { source: "gateway", priority: "high" },
    );
    pushToSubscribers("push.stateChange", {
      previousState: "paused",
      currentState: "running",
      timestamp: Date.now(),
    });
    return { resumed: true };
  });

  registerHandler("brain.triggerAction", async (params, clientId) => {
    const parsed = BrainTriggerActionParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid brain.triggerAction params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { action, args } = parsed.data;

    const ALLOWED_ACTIONS = new Set(["dream", "learn", "check_telegram", "health_check", "consolidate"]);
    if (!ALLOWED_ACTIONS.has(action)) {
      throw new RpcValidationError(`Unknown action: ${action}. Allowed: ${[...ALLOWED_ACTIONS].join(", ")}`);
    }

    logger.info("brain.triggerAction", `Client ${clientId} triggered action: ${action}`);
    eventBus.publish(
      "system:config_changed",
      { action: "trigger", triggerAction: action, args: args ?? {}, requestedBy: clientId },
      { source: "gateway", priority: "high" },
    );
    return { triggered: true, action };
  });

  registerHandler("brain.getLog", async (params) => {
    const parsed = BrainGetLogParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid brain.getLog params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const limit = parsed.data.limit ?? 50;
    return { entries: [], limit, note: "Override this handler with actual log retrieval" };
  });

  // -----------------------------------------------------------------------
  // Client management handlers
  // -----------------------------------------------------------------------

  registerHandler("client.list", async () => {
    const clients: ConnectedClientInfo[] = [];
    for (const client of deps.getClients()) {
      if (!client.authenticated) continue;
      clients.push({
        id: client.id,
        platform: client.platform,
        version: client.version,
        connectedAt: client.connectedAt,
        subscribed: deps.isSubscribed(client.id),
      });
    }
    return { clients };
  });

  registerHandler("client.execute", async (params, fromClientId) => {
    const fromClient = deps.getClient(fromClientId);
    if (!fromClient || !fromClient.authenticated) {
      throw new RpcValidationError("Unauthorized: client.execute requires an authenticated session");
    }

    const parsed = ClientExecuteParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid client.execute params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { targetClientId, command, args } = parsed.data;

    if (targetClientId === fromClientId) {
      throw new RpcValidationError("Cannot execute commands on self via client.execute");
    }

    const targetClient = deps.getClient(targetClientId);
    if (!targetClient || !targetClient.authenticated) {
      throw new RpcValidationError(`Target client ${targetClientId} not found or not authenticated`);
    }

    const commandId = randomUUID();
    const pushPayload = createPushEvent("push.executeCommand", {
      commandId,
      command,
      args: args ?? null,
      fromClientId,
    });

    const sent = deps.sendToClient(targetClientId, JSON.stringify(pushPayload));
    if (!sent) {
      throw new RpcValidationError(`Failed to send command to target client ${targetClientId}`);
    }

    logger.info(
      "client.execute",
      `Client ${fromClientId} sent command "${command}" to ${targetClientId} (${commandId})`,
    );
    return { sent: true, commandId, targetClientId };
  });

  registerHandler("command.result", async (params, clientId) => {
    const parsed = CommandResultParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid command.result params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { commandId, success, result, error } = parsed.data;

    const wasSuccessful = success ?? false;
    logger.info(
      "command.result",
      `Client ${clientId} reported command ${commandId} result: ${wasSuccessful ? "success" : "failure"}`,
    );

    eventBus.publish(
      "gateway:client_error_report",
      {
        clientId,
        commandId,
        success: wasSuccessful,
        result: result ?? null,
        error,
      },
      { source: "gateway" },
    );

    return { received: true, commandId };
  });

  // -----------------------------------------------------------------------
  // Research handlers
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Profile handlers
  // -----------------------------------------------------------------------

  registerHandler("profile.get", async () => {
    return { profile: null, note: "Override this handler with actual profile generation" };
  });

  // -----------------------------------------------------------------------
  // Metrics handlers
  // -----------------------------------------------------------------------

  registerHandler("metrics.rateLimits", async () => {
    if (!deps.rateLimitTracker) {
      return { accounts: [], note: "RateLimitTracker not configured" };
    }
    const statuses = deps.rateLimitTracker.getAllAccountStatuses();
    return { accounts: statuses };
  });

  // -----------------------------------------------------------------------
  // Approval handlers
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Automation handlers
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // System health handler
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Calendar handlers (only registered when CalendarManager is provided)
  // -----------------------------------------------------------------------

  if (deps.calendarManager) {
    registerCalendarHandlers(deps.calendarManager, registerHandler);
  }
}

// ---------------------------------------------------------------------------
// Calendar handler registration
// ---------------------------------------------------------------------------

function registerCalendarHandlers(
  calendar: CalendarManager,
  registerHandler: (method: GatewayMethod, handler: MethodHandler) => void,
): void {
  registerHandler("calendar.listEvents", async (params) => {
    const parsed = CalendarListEventsParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid calendar.listEvents params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { start, end } = parsed.data;
    const result = calendar.listEvents(start, end);
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }
    return { events: result.value };
  });

  registerHandler("calendar.getUpcoming", async (params) => {
    const parsed = CalendarGetUpcomingParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid calendar.getUpcoming params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const hours = parsed.data.hours ?? 24;
    const result = calendar.getUpcoming(hours);
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }
    return { events: result.value };
  });

  registerHandler("calendar.createEvent", async (params) => {
    const parsed = CalendarCreateEventParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid calendar.createEvent params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const { title, startTime, endTime, description, location, allDay, calendarId } = parsed.data;
    const result = calendar.createEvent({
      calendarId: calendarId ?? "default",
      title,
      startTime,
      endTime,
      description,
      location,
      allDay: allDay ?? false,
      reminders: [],
      source: "manual",
    });
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }
    return result.value;
  });

  registerHandler("calendar.conflicts", async (params) => {
    const parsed = CalendarConflictsParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid calendar.conflicts params: ${parsed.error.issues.map((issue: z.ZodIssue) => issue.message).join(", ")}`,
      );
    }
    const now = Date.now();
    const start = parsed.data.start ?? now;
    const end = parsed.data.end ?? now + 7 * 86_400_000;
    const result = calendar.findConflicts(start, end);
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }
    return { conflicts: result.value };
  });
}
