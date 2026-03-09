/**
 * Gateway RPC handler wiring steps for Calendar, HA, Audit, Metrics,
 * Plugin/LLM, Feedback, and Profile.
 *
 * Extracted from gateway-wiring.ts to keep each module under ~300 lines.
 */

import type { CalendarEvent } from "@eidolon/protocol";
import { z } from "zod";
import { CalendarManager } from "../calendar/manager.ts";
import { registerFeedbackHandlers } from "../feedback/gateway-handlers.ts";
import {
  CalendarCreateEventParamsSchema,
  CalendarGetUpcomingParamsSchema,
  CalendarListEventsParamsSchema,
  RpcValidationError,
} from "../gateway/rpc-schemas.ts";
import { HAManager } from "../home-automation/manager.ts";
import { wireMetrics } from "../metrics/wiring.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Validation schemas for RPC handler params
// ---------------------------------------------------------------------------

const HAExecuteParamsSchema = z.object({
  entityId: z.string().min(1),
  domain: z.string().min(1),
  service: z.string().min(1),
  data: z.record(z.unknown()).optional(),
});

const CalendarDeleteEventParamsSchema = z.object({
  eventId: z.string().min(1),
});

const HAStateParamsSchema = z.object({
  entityId: z.string().min(1),
});

const HAEntitiesParamsSchema = z.object({
  domain: z.string().optional(),
});

const PluginInfoParamsSchema = z.object({
  name: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Init step type (matches gateway-wiring.ts convention)
// ---------------------------------------------------------------------------

type InitStep = { name: string; fn: () => Promise<void> | void };

// ---------------------------------------------------------------------------
// Calendar steps
// ---------------------------------------------------------------------------

export function buildCalendarSteps(modules: InitializedModules): InitStep[] {
  const steps: InitStep[] = [];

  // 19a-cal. CalendarManager (needs DB, Logger, EventBus, Config)
  steps.push({
    name: "CalendarManager",
    fn: async () => {
      const db = modules.dbManager?.operational;
      const logger = modules.logger;
      const eventBus = modules.eventBus;
      const config = modules.config;
      if (!db || !logger || !eventBus || !config) return;
      if (!config.calendar?.enabled) {
        logger.info("daemon", "Calendar integration disabled");
        return;
      }

      const calendarManager = new CalendarManager({
        db,
        logger,
        eventBus,
        config: config.calendar,
      });

      const initResult = await calendarManager.initialize();
      if (!initResult.ok) {
        logger.warn("daemon", `CalendarManager init failed: ${initResult.error.message}`);
        return;
      }

      modules.calendarManager = calendarManager;
      logger.info("daemon", "CalendarManager initialized");
    },
  });

  // 19a-cal-gw. Wire calendar gateway RPC handlers
  steps.push({
    name: "GatewayCalendarWiring",
    fn: () => {
      const gatewayServer = modules.gatewayServer;
      const calendarManager = modules.calendarManager;
      const logger = modules.logger;
      if (!gatewayServer || !calendarManager) {
        logger?.debug("daemon", "Calendar gateway wiring skipped: missing gateway or calendarManager");
        return;
      }

      gatewayServer.registerHandler("calendar.listEvents", async (params) => {
        const parsed = CalendarListEventsParamsSchema.safeParse(params);
        if (!parsed.success) {
          throw new RpcValidationError(
            `Invalid calendar.listEvents params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
          );
        }
        const result = calendarManager.listEvents(parsed.data.start, parsed.data.end);
        if (!result.ok) throw new RpcValidationError(result.error.message);
        return { events: result.value };
      });

      gatewayServer.registerHandler("calendar.createEvent", async (params) => {
        const parsed = CalendarCreateEventParamsSchema.safeParse(params);
        if (!parsed.success) {
          throw new RpcValidationError(
            `Invalid calendar.createEvent params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
          );
        }
        const event = parsed.data as Omit<CalendarEvent, "id" | "syncedAt">;
        const result = calendarManager.createEvent(event);
        if (!result.ok) throw new RpcValidationError(result.error.message);
        return { event: result.value };
      });

      gatewayServer.registerHandler("calendar.deleteEvent", async (params) => {
        const parsed = CalendarDeleteEventParamsSchema.safeParse(params);
        if (!parsed.success) {
          throw new RpcValidationError(
            `Invalid calendar.deleteEvent params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
          );
        }
        const result = calendarManager.deleteEvent(parsed.data.eventId);
        if (!result.ok) throw new RpcValidationError(result.error.message);
        return { success: true };
      });

      const CalendarSyncParamsSchema = z.object({
        providerName: z.string().min(1).optional(),
      });

      gatewayServer.registerHandler("calendar.sync", async (params) => {
        const parsed = CalendarSyncParamsSchema.safeParse(params);
        if (!parsed.success) {
          throw new RpcValidationError(
            `Invalid calendar.sync params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
          );
        }
        const result = await calendarManager.sync(parsed.data.providerName);
        if (!result.ok) throw new RpcValidationError(result.error.message);
        return result.value;
      });

      gatewayServer.registerHandler("calendar.getUpcoming", async (params) => {
        const parsed = CalendarGetUpcomingParamsSchema.safeParse(params);
        if (!parsed.success) {
          throw new RpcValidationError(
            `Invalid calendar.getUpcoming params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
          );
        }
        const result = calendarManager.getUpcoming(parsed.data.hours ?? 24);
        if (!result.ok) throw new RpcValidationError(result.error.message);
        return { events: result.value };
      });

      logger?.info("daemon", "Calendar RPC handlers registered on gateway");
    },
  });

  return steps;
}

// ---------------------------------------------------------------------------
// Home Automation steps
// ---------------------------------------------------------------------------

export function buildHASteps(modules: InitializedModules): InitStep[] {
  const steps: InitStep[] = [];

  // 19a-ha. HAManager (needs DB, Logger, EventBus, Config, optionally EmbeddingModel)
  steps.push({
    name: "HAManager",
    fn: async () => {
      const db = modules.dbManager?.operational;
      const logger = modules.logger;
      const eventBus = modules.eventBus;
      const config = modules.config;
      if (!db || !logger || !eventBus || !config) return;
      if (!config.homeAutomation?.enabled) {
        logger.info("daemon", "Home automation integration disabled");
        return;
      }

      const haManager = new HAManager({
        db,
        logger,
        eventBus,
        config: config.homeAutomation,
        embeddingModel: modules.embeddingModel,
      });

      const initResult = await haManager.initialize();
      if (!initResult.ok) {
        logger.warn("daemon", `HAManager init failed: ${initResult.error.message}`);
        return;
      }

      modules.haManager = haManager;
      logger.info("daemon", "HAManager initialized");
    },
  });

  // 19a-ha-gw. Wire HA gateway RPC handlers
  steps.push({
    name: "GatewayHAWiring",
    fn: () => {
      const gatewayServer = modules.gatewayServer;
      const haManager = modules.haManager;
      const logger = modules.logger;
      if (!gatewayServer || !haManager) {
        logger?.debug("daemon", "HA gateway wiring skipped: missing gateway or haManager");
        return;
      }

      gatewayServer.registerHandler("ha.entities", async (params) => {
        const parsed = HAEntitiesParamsSchema.safeParse(params);
        if (!parsed.success) {
          throw new RpcValidationError(
            `Invalid ha.entities params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
          );
        }
        const result = haManager.listEntities(parsed.data.domain);
        if (!result.ok) throw new RpcValidationError(result.error.message);
        return { entities: result.value };
      });

      gatewayServer.registerHandler("ha.scenes", async () => {
        const result = haManager.sceneEngine.listScenes();
        if (!result.ok) throw new RpcValidationError(result.error.message);
        return { scenes: result.value };
      });

      gatewayServer.registerHandler("ha.execute", async (params) => {
        const parsed = HAExecuteParamsSchema.safeParse(params);
        if (!parsed.success) {
          throw new RpcValidationError(
            `Invalid ha.execute params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
          );
        }
        const { entityId, domain, service, data } = parsed.data;
        const result = await haManager.executeService(entityId, domain, service, data);
        if (!result.ok) throw new RpcValidationError(result.error.message);
        return result.value;
      });

      gatewayServer.registerHandler("ha.state", async (params) => {
        const parsed = HAStateParamsSchema.safeParse(params);
        if (!parsed.success) {
          throw new RpcValidationError(
            `Invalid ha.state params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
          );
        }
        const result = haManager.getEntity(parsed.data.entityId);
        if (!result.ok) throw new RpcValidationError(result.error.message);
        if (!result.value) throw new RpcValidationError("Entity not found");
        return { entity: result.value };
      });

      logger?.info("daemon", "HA RPC handlers registered on gateway");
    },
  });

  return steps;
}

// ---------------------------------------------------------------------------
// Audit, Metrics, Plugin/LLM, Feedback, Profile steps
// ---------------------------------------------------------------------------

export function buildMiscGatewaySteps(modules: InitializedModules): InitStep[] {
  const steps: InitStep[] = [];

  // 19b. Wire gateway auth events to AuditLogger
  steps.push({
    name: "GatewayAuditWiring",
    fn: () => {
      const eventBus = modules.eventBus;
      const auditLogger = modules.auditLogger;
      const logger = modules.logger;
      if (!eventBus || !auditLogger) return;

      eventBus.subscribe("gateway:client_connected", (event) => {
        const payload = event.payload as { clientId?: string; authenticated?: boolean };
        const authenticated = payload.authenticated === true;
        auditLogger.log({
          actor: `client:${payload.clientId ?? "unknown"}`,
          action: "gateway.auth",
          target: "gateway",
          result: authenticated ? "success" : "failure",
          details: { clientId: payload.clientId },
        });
      });

      logger?.info("daemon", "Gateway auth events wired to AuditLogger");
    },
  });

  // 19c. Wire Prometheus metrics to EventBus + SessionSupervisor
  steps.push({
    name: "MetricsWiring",
    fn: () => {
      const metricsRegistry = modules.metricsRegistry;
      const eventBus = modules.eventBus;
      const logger = modules.logger;
      if (!metricsRegistry || !eventBus || !logger) return;

      modules.metricsWiring = wireMetrics({
        metricsRegistry,
        eventBus,
        logger,
        sessionSupervisor: modules.sessionSupervisor,
      });
    },
  });

  // 19d. Wire plugin + LLM RPC handlers to gateway
  steps.push({
    name: "PluginLlmGatewayWiring",
    fn: () => {
      const gateway = modules.gatewayServer;
      const logger = modules.logger;
      if (!gateway || !logger) return;

      // Plugin RPC handlers
      const registry = modules.pluginRegistry;
      if (registry) {
        gateway.registerHandler("plugin.list", async () => registry.getAll());
        gateway.registerHandler("plugin.info", async (params: unknown) => {
          const parsed = PluginInfoParamsSchema.safeParse(params);
          if (!parsed.success) {
            throw new RpcValidationError(
              `Invalid plugin.info params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
            );
          }
          return registry.get(parsed.data.name) ?? null;
        });
        logger.info("daemon", "Plugin RPC handlers wired to gateway");
      }

      // LLM RPC handlers
      const router = modules.modelRouter;
      if (router) {
        gateway.registerHandler("llm.providers", async () =>
          router.getAllProviders().map((p) => ({ type: p.type, name: p.name })),
        );
        gateway.registerHandler("llm.models", async () => {
          const result: Array<{ provider: string; models: readonly string[] }> = [];
          for (const p of router.getAllProviders()) {
            try {
              const models = await p.listModels();
              result.push({ provider: p.type, models });
            } catch {
              // Intentional: provider model listing failure returns empty list
              result.push({ provider: p.type, models: [] });
            }
          }
          return result;
        });
        logger.info("daemon", "LLM RPC handlers wired to gateway");
      }
    },
  });

  // 19e. Wire feedback RPC handlers to gateway
  steps.push({
    name: "GatewayFeedbackWiring",
    fn: () => {
      const gateway = modules.gatewayServer;
      const feedbackStore = modules.feedbackStore;
      const eventBus = modules.eventBus;
      const logger = modules.logger;
      if (!gateway || !feedbackStore || !eventBus || !logger) {
        logger?.debug("daemon", "Feedback gateway wiring skipped: missing gateway, feedbackStore, or eventBus");
        return;
      }

      registerFeedbackHandlers({ gateway, feedbackStore, eventBus, logger });
      logger.info("daemon", "Feedback RPC handlers registered on gateway");
    },
  });

  // 19f. Wire profile.get RPC handler to gateway
  steps.push({
    name: "GatewayProfileWiring",
    fn: () => {
      const gateway = modules.gatewayServer;
      const profileGenerator = modules.profileGenerator;
      const logger = modules.logger;
      if (!gateway || !logger) {
        logger?.debug("daemon", "Profile gateway wiring skipped: missing gateway");
        return;
      }

      if (profileGenerator) {
        gateway.registerHandler("profile.get", async () => {
          const profile = profileGenerator.generateProfile();
          return { profile };
        });
        logger.info("daemon", "Profile RPC handler (profile.get) wired to gateway");
      } else {
        logger.debug("daemon", "Profile gateway wiring skipped: no UserProfileGenerator available");
      }
    },
  });

  return steps;
}
