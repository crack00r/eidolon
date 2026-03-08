/**
 * Built-in RPC handler registrations for the Gateway server.
 *
 * Extracted from server.ts (P1-26) to keep the server module focused
 * on WebSocket lifecycle and connection management.
 *
 * Calendar handlers are in builtin-handlers-calendar.ts.
 */

import { randomUUID } from "node:crypto";
import type { ConnectedClientInfo, GatewayMethod, GatewayPushType } from "@eidolon/protocol";
import type { z } from "zod";
import type { CalendarManager } from "../calendar/index.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { RateLimitTracker } from "../metrics/rate-limits.ts";
import { registerCalendarHandlers } from "./builtin-handlers-calendar.ts";
import { registerMiscHandlers, registerResearchHandlers } from "./builtin-handlers-research.ts";
import { createPushEvent } from "./protocol.ts";
import {
  BrainGetLogParamsSchema,
  BrainTriggerActionParamsSchema,
  ClientExecuteParamsSchema,
  CommandResultParamsSchema,
  ErrorReportParamsSchema,
  RpcValidationError,
} from "./rpc-schemas.ts";
import type { ClientState, MethodHandler } from "./server-helpers.ts";

// ---------------------------------------------------------------------------
// Types for the registration context
// ---------------------------------------------------------------------------

export interface BuiltinHandlerDeps {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly rateLimitTracker: RateLimitTracker | undefined;
  readonly calendarManager: CalendarManager | undefined;
  registerHandler: (method: GatewayMethod, handler: MethodHandler) => void;
  getClient: (clientId: string) => ClientState | undefined;
  getClients: () => IterableIterator<ClientState>;
  getClientCount: () => number;
  isSubscribed: (clientId: string) => boolean;
  addSubscriber: (clientId: string) => void;
  pushToSubscribers: (type: GatewayPushType, data: Record<string, unknown>) => void;
  sendToClient: (clientId: string, data: string) => boolean;
  isRunning: () => boolean;
  getStartTime: () => number;
}

// ---------------------------------------------------------------------------
// Built-in handler registration
// ---------------------------------------------------------------------------

/** Register all built-in RPC handlers on the gateway. */
export function registerBuiltinHandlers(deps: BuiltinHandlerDeps): void {
  const { logger, eventBus, registerHandler } = deps;

  // error.report / client.reportErrors
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

  // Brain control handlers
  registerBrainHandlers(deps);

  // Client management handlers
  registerClientHandlers(deps);

  // Research handlers
  registerResearchHandlers(deps);

  // Profile, metrics, approval, automation, health handlers
  registerMiscHandlers(deps);

  // Calendar handlers
  if (deps.calendarManager) {
    registerCalendarHandlers(deps.calendarManager, registerHandler);
  }
}

// ---------------------------------------------------------------------------
// Brain control
// ---------------------------------------------------------------------------

function registerBrainHandlers(deps: BuiltinHandlerDeps): void {
  const { logger, eventBus, registerHandler, pushToSubscribers } = deps;

  // NOTE: brain.pause, brain.resume, and brain.triggerAction intentionally have
  // no authorization check beyond WebSocket authentication. Eidolon is a single-user
  // system where all authenticated gateway clients are trusted to control the brain.
  // If multi-user role-based access is added, these handlers should check roles.
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
}

// ---------------------------------------------------------------------------
// Client management
// ---------------------------------------------------------------------------

function registerClientHandlers(deps: BuiltinHandlerDeps): void {
  const { logger, eventBus, registerHandler } = deps;

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
      { clientId, commandId, success: wasSuccessful, result: result ?? null, error },
      { source: "gateway" },
    );

    return { received: true, commandId };
  });
}
