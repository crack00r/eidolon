/**
 * Gateway handler registration and auxiliary service wiring.
 *
 * Registers GPU pool, WhatsApp webhook, Calendar, Home Automation,
 * audit, metrics, plugin/LLM RPC handlers on the GatewayServer.
 * Also initializes TailscaleDetector and DiscoveryBroadcaster.
 *
 * Calendar, HA, and misc handler wiring steps are in gateway-wiring-handlers.ts.
 */

import { DiscoveryBroadcaster } from "../discovery/broadcaster.ts";
import { TailscaleDetector } from "../discovery/tailscale.ts";
import { GatewayChannel } from "../gateway/gateway-channel.ts";
import { GatewayServer } from "../gateway/server.ts";
import { GPUManager } from "../gpu/manager.ts";
import type { GPUWorkerPoolConfig } from "../gpu/pool.ts";
import { GPUWorkerPool } from "../gpu/pool.ts";
import { STTClient } from "../gpu/stt-client.ts";
import type { GPUWorkerConfig as PoolWorkerConfig } from "../gpu/worker.ts";
import { DiscoveryEngine } from "../learning/discovery.ts";
import { buildCoreRpcWiringStep } from "./core-rpc-wiring.ts";
import { buildCalendarSteps, buildHASteps, buildMiscGatewaySteps } from "./gateway-wiring-handlers.ts";
import type { InitializedModules } from "./types.ts";

// Re-export sub-module functions for barrel access
export { buildCalendarSteps, buildHASteps, buildMiscGatewaySteps } from "./gateway-wiring-handlers.ts";

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

  // 19-gw-channel. Register GatewayChannel with MessageRouter for outbound routing
  steps.push({
    name: "GatewayChannelWiring",
    fn: () => {
      const gatewayServer = modules.gatewayServer;
      const messageRouter = modules.messageRouter;
      const logger = modules.logger;

      if (!gatewayServer || !messageRouter) {
        logger?.debug("daemon", "GatewayChannel wiring skipped: missing gateway server or messageRouter");
        return;
      }

      const gatewayChannel = new GatewayChannel();
      gatewayChannel.setServer(gatewayServer);
      messageRouter.registerChannel(gatewayChannel);

      logger?.info("daemon", "GatewayChannel registered with MessageRouter (channel ID: gateway)");
    },
  });

  // 19-core. Wire core RPC handlers (chat, memory, session, learning, voice)
  steps.push(buildCoreRpcWiringStep(modules));

  // 19-rest. Wire REST API deps to GatewayServer
  steps.push({
    name: "GatewayRestApiWiring",
    fn: () => {
      const gatewayServer = modules.gatewayServer;
      const logger = modules.logger;

      if (!gatewayServer) {
        logger?.debug("daemon", "REST API wiring skipped: no gateway server");
        return;
      }

      // Initialize DiscoveryEngine for REST API (if DB available)
      let discoveryEngine: DiscoveryEngine | undefined;
      if (modules.dbManager && logger) {
        discoveryEngine = new DiscoveryEngine(modules.dbManager.operational, logger);
      }

      gatewayServer.setRestApiDeps({
        memoryStore: modules.memoryStore,
        memorySearch: modules.memorySearch,
        conversationStore: modules.conversationStore,
        discoveryEngine,
      });

      logger?.info("daemon", "REST API deps wired to gateway");
    },
  });

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

  // 19a-cal + 19a-cal-gw. Calendar manager + gateway wiring
  steps.push(...buildCalendarSteps(modules));

  // 19a-ha + 19a-ha-gw. HA manager + gateway wiring
  steps.push(...buildHASteps(modules));

  // 19b-19f. Audit, metrics, plugin/LLM, feedback, profile
  steps.push(...buildMiscGatewaySteps(modules));

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
