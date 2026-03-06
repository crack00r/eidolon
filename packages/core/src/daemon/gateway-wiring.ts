/**
 * Gateway handler registration and auxiliary service wiring.
 *
 * Registers GPU pool, WhatsApp webhook, Calendar, Home Automation,
 * audit, metrics, plugin/LLM RPC handlers on the GatewayServer.
 * Also initializes TailscaleDetector and DiscoveryBroadcaster.
 */

import type { CalendarEvent } from "@eidolon/protocol";
import { CalendarManager } from "../calendar/manager.ts";
import { DiscoveryBroadcaster } from "../discovery/broadcaster.ts";
import { TailscaleDetector } from "../discovery/tailscale.ts";
import { registerFeedbackHandlers } from "../feedback/gateway-handlers.ts";
import { GatewayServer } from "../gateway/server.ts";
import { GPUManager } from "../gpu/manager.ts";
import type { GPUWorkerPoolConfig } from "../gpu/pool.ts";
import { GPUWorkerPool } from "../gpu/pool.ts";
import { STTClient } from "../gpu/stt-client.ts";
import type { GPUWorkerConfig as PoolWorkerConfig } from "../gpu/worker.ts";
import { HAManager } from "../home-automation/manager.ts";
import { wireMetrics } from "../metrics/wiring.ts";
import { buildCoreRpcWiringStep } from "./core-rpc-wiring.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Public: wire gateway and auxiliary services
// ---------------------------------------------------------------------------

/**
 * Builds the ordered list of init steps for gateway-related wiring.
 * Steps 18-21 in the original daemon initialization sequence.
 */
export function buildGatewayInitSteps(
  modules: InitializedModules,
): Array<{ name: string; fn: () => Promise<void> | void }> {
  const steps: Array<{ name: string; fn: () => Promise<void> | void }> = [];

  // 18. GPUManager + GPUWorkerPool (needs Config, Logger)
  steps.push({
    name: "GPUManager",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      if (!logger) return;

      const workers = config?.gpu.workers ?? [];
      if (workers.length === 0 || !config) {
        logger.info("daemon", "GPUManager skipped: no GPU workers configured");
        return;
      }

      try {
        // Legacy single-worker GPUManager (backward compat)
        const firstWorker = workers[0];
        if (!firstWorker) return;
        modules.gpuManager = new GPUManager(
          {
            url: `http://${firstWorker.host}:${firstWorker.port}`,
            apiKey: typeof firstWorker.token === "string" ? firstWorker.token : undefined,
          },
          logger,
        );

        // Multi-worker pool
        const poolWorkers: PoolWorkerConfig[] = workers.map((w) => ({
          name: w.name,
          url: `http://${w.host}:${w.port}`,
          apiKey: typeof w.token === "string" ? w.token : undefined,
          capabilities: w.capabilities as readonly ("tts" | "stt" | "realtime")[],
          priority: w.priority,
          maxConcurrent: w.maxConcurrent,
        }));

        const poolConfig: GPUWorkerPoolConfig = {
          workers: poolWorkers,
          healthCheckIntervalMs: config.gpu.pool.healthCheckIntervalMs,
          loadBalancing: config.gpu.pool.loadBalancing,
          maxRetries: config.gpu.pool.maxRetriesPerRequest,
        };

        modules.gpuWorkerPool = new GPUWorkerPool(poolConfig, logger);
        modules.gpuWorkerPool.startHealthChecks();

        logger.info(
          "daemon",
          `GPUManager initialized (${workers.length} worker(s) in pool, strategy: ${config.gpu.pool.loadBalancing})`,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `GPUManager skipped: ${message}`);
      }
    },
  });

  // 18a. STTClient (needs GPUManager, Logger)
  steps.push({
    name: "STTClient",
    fn: () => {
      const logger = modules.logger;
      const gpuManager = modules.gpuManager;
      if (!logger || !gpuManager) {
        logger?.debug("daemon", "STTClient skipped: no GPUManager available");
        return;
      }

      modules.sttClient = new STTClient(gpuManager, logger);
      logger.info("daemon", "STTClient initialized");
    },
  });

  // 19. GatewayServer (needs Config, Logger, EventBus)
  steps.push({
    name: "GatewayServer",
    fn: async () => {
      const config = modules.config;
      const logger = modules.logger;
      const eventBus = modules.eventBus;
      if (!config || !logger || !eventBus) {
        logger?.warn("daemon", "GatewayServer skipped: missing dependencies");
        return;
      }

      modules.gatewayServer = new GatewayServer({
        config: config.gateway,
        logger,
        eventBus,
        metricsRegistry: modules.metricsRegistry,
        modelRouter: modules.modelRouter,
        brainConfig: config.brain,
      });
      await modules.gatewayServer.start();
      logger.info("daemon", `GatewayServer started on ${config.gateway.host}:${config.gateway.port}`);
    },
  });

  // 19-core. Wire core RPC handlers (chat, memory, session, learning, voice)
  steps.push(buildCoreRpcWiringStep(modules));

  // 19a. Wire GPU pool RPC handlers to GatewayServer
  steps.push({
    name: "GatewayGpuWiring",
    fn: () => {
      const gatewayServer = modules.gatewayServer;
      const gpuPool = modules.gpuWorkerPool;
      const logger = modules.logger;
      if (!gatewayServer || !gpuPool) {
        logger?.debug("daemon", "GPU pool gateway wiring skipped: missing gateway or pool");
        return;
      }

      gatewayServer.registerHandler("gpu.workers", async () => {
        const status = gpuPool.getPoolStatus();
        return { workers: status.workers };
      });

      gatewayServer.registerHandler("gpu.pool_status", async () => {
        return gpuPool.getPoolStatus();
      });

      logger?.info("daemon", "GPU pool RPC handlers registered on gateway");
    },
  });

  // 19a-wa. Wire WhatsApp webhook handler to GatewayServer
  steps.push({
    name: "GatewayWhatsAppWiring",
    fn: () => {
      const gatewayServer = modules.gatewayServer;
      const whatsappChannel = modules.whatsappChannel;
      const config = modules.config;
      const logger = modules.logger;

      if (!gatewayServer || !whatsappChannel || !config?.channels.whatsapp) {
        logger?.debug("daemon", "WhatsApp gateway wiring skipped: missing gateway or channel");
        return;
      }

      const waConfig = config.channels.whatsapp;
      const verifyToken = waConfig.verifyToken;
      const appSecret = waConfig.appSecret;

      if (typeof verifyToken !== "string" || typeof appSecret !== "string") {
        logger?.warn("daemon", "WhatsApp gateway wiring skipped: unresolved secrets");
        return;
      }

      gatewayServer.setWhatsAppChannel(whatsappChannel, verifyToken, appSecret);
      logger?.info("daemon", "WhatsApp webhook handler registered on gateway");
    },
  });

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
        const start = typeof params.start === "number" ? params.start : Date.now();
        const end = typeof params.end === "number" ? params.end : start + 7 * 86_400_000;
        const result = calendarManager.listEvents(start, end);
        if (!result.ok) throw new Error(result.error.message);
        return { events: result.value };
      });

      gatewayServer.registerHandler("calendar.createEvent", async (params) => {
        const event = params as Omit<CalendarEvent, "id" | "syncedAt">;
        const result = calendarManager.createEvent(event);
        if (!result.ok) throw new Error(result.error.message);
        return { event: result.value };
      });

      gatewayServer.registerHandler("calendar.deleteEvent", async (params) => {
        const eventId = typeof params.eventId === "string" ? params.eventId : "";
        const result = calendarManager.deleteEvent(eventId);
        if (!result.ok) throw new Error(result.error.message);
        return { success: true };
      });

      gatewayServer.registerHandler("calendar.sync", async (params) => {
        const providerName = typeof params.providerName === "string" ? params.providerName : undefined;
        const result = await calendarManager.sync(providerName);
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      });

      gatewayServer.registerHandler("calendar.getUpcoming", async (params) => {
        const hours = typeof params.hours === "number" ? params.hours : 24;
        const result = calendarManager.getUpcoming(hours);
        if (!result.ok) throw new Error(result.error.message);
        return { events: result.value };
      });

      logger?.info("daemon", "Calendar RPC handlers registered on gateway");
    },
  });

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
        const domain = typeof params.domain === "string" ? params.domain : undefined;
        const result = haManager.listEntities(domain);
        if (!result.ok) throw new Error(result.error.message);
        return { entities: result.value };
      });

      gatewayServer.registerHandler("ha.scenes", async () => {
        const result = haManager.sceneEngine.listScenes();
        if (!result.ok) throw new Error(result.error.message);
        return { scenes: result.value };
      });

      gatewayServer.registerHandler("ha.execute", async (params) => {
        const entityId = typeof params.entityId === "string" ? params.entityId : "";
        const domain = typeof params.domain === "string" ? params.domain : "";
        const service = typeof params.service === "string" ? params.service : "";
        const data =
          typeof params.data === "object" && params.data !== null
            ? (params.data as Record<string, unknown>)
            : undefined;
        const result = await haManager.executeService(entityId, domain, service, data);
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      });

      gatewayServer.registerHandler("ha.state", async (params) => {
        const entityId = typeof params.entityId === "string" ? params.entityId : "";
        const result = haManager.getEntity(entityId);
        if (!result.ok) throw new Error(result.error.message);
        if (!result.value) throw new Error(`Entity not found: ${entityId}`);
        return { entity: result.value };
      });

      logger?.info("daemon", "HA RPC handlers registered on gateway");
    },
  });

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
        gateway.registerHandler("plugin.list" as never, async () => registry.getAll());
        gateway.registerHandler("plugin.info" as never, async (params: unknown) => {
          const { name } = params as { name: string };
          return registry.get(name) ?? null;
        });
        logger.info("daemon", "Plugin RPC handlers wired to gateway");
      }

      // LLM RPC handlers
      const router = modules.modelRouter;
      if (router) {
        gateway.registerHandler("llm.providers" as never, async () =>
          router.getAllProviders().map((p) => ({ type: p.type, name: p.name })),
        );
        gateway.registerHandler("llm.models" as never, async () => {
          const result: Array<{ provider: string; models: readonly string[] }> = [];
          for (const p of router.getAllProviders()) {
            try {
              const models = await p.listModels();
              result.push({ provider: p.type, models });
            } catch {
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
        gateway.registerHandler("profile.get" as never, async () => {
          const profile = profileGenerator.generateProfile();
          return { profile };
        });
        logger.info("daemon", "Profile RPC handler (profile.get) wired to gateway");
      } else {
        logger.debug("daemon", "Profile gateway wiring skipped: no UserProfileGenerator available");
      }
    },
  });

  // 20. TailscaleDetector (needs Logger)
  steps.push({
    name: "TailscaleDetector",
    fn: () => {
      const logger = modules.logger;
      if (!logger) return;

      modules.tailscaleDetector = new TailscaleDetector(logger);
      modules.tailscaleDetector.start();
      logger.info("daemon", "TailscaleDetector started");
    },
  });

  // 21. DiscoveryBroadcaster (needs Config, Logger, TailscaleDetector)
  steps.push({
    name: "DiscoveryBroadcaster",
    fn: async () => {
      const config = modules.config;
      const logger = modules.logger;
      if (!config || !logger) return;

      modules.discoveryBroadcaster = new DiscoveryBroadcaster({
        logger,
        gatewayPort: config.gateway.port,
        tlsEnabled: config.gateway.tls.enabled,
        tailscale: modules.tailscaleDetector,
      });
      await modules.discoveryBroadcaster.start();
      logger.info("daemon", "DiscoveryBroadcaster started");
    },
  });

  return steps;
}
