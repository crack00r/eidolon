/**
 * Service init steps: HealthChecker, MCPHealthMonitor, TokenTracker,
 * MetricsRegistry, Telemetry, BackupManager, HealthServer, EventBus,
 * FeedbackStore, ApprovalManager.
 * Steps 6-10c from the daemon initialization sequence.
 */

import { BackupManager } from "../backup/manager.ts";
import { ConversationSessionStore } from "../claude/session-store.ts";
import { getConfigPath, getDataDir } from "../config/paths.ts";
import { subscribeFeedbackConfidenceAdjustment } from "../feedback/confidence.ts";
import { FeedbackStore } from "../feedback/store.ts";
import { HealthChecker } from "../health/checker.ts";
import {
  createBunCheck,
  createClaudeCheck,
  createConfigCheck,
  createDatabaseCheck,
  createDiskCheck,
} from "../health/checks/index.ts";
import { createHealthServer } from "../health/server.ts";
import { EventBus } from "../loop/event-bus.ts";
import { MCPHealthMonitor } from "../mcp/health.ts";
import { MetricsRegistry } from "../metrics/prometheus.ts";
import { TokenTracker } from "../metrics/token-tracker.ts";
import { ApprovalManager } from "../security/approval-manager.ts";
import { createMetricsBridge } from "../telemetry/metrics-bridge.ts";
import { initTelemetry } from "../telemetry/provider.ts";
import type { DaemonOptions, InitializedModules } from "./types.ts";

type InitStep = { name: string; fn: () => Promise<void> | void };

export function buildServiceSteps(modules: InitializedModules, options?: DaemonOptions): InitStep[] {
  const steps: InitStep[] = [];

  // 6. HealthChecker (needs Logger)
  steps.push({
    name: "HealthChecker",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      if (!logger) throw new Error("Logger required for HealthChecker");

      modules.healthChecker = new HealthChecker(logger);

      modules.healthChecker.register("bun", createBunCheck());

      if (modules.dbManager) {
        modules.healthChecker.register("databases", createDatabaseCheck(modules.dbManager));
      }

      const dataDir = config?.database.directory || getDataDir();
      modules.healthChecker.register("disk", createDiskCheck(dataDir));

      const configPath = options?.configPath ?? getConfigPath();
      modules.healthChecker.register("config", createConfigCheck(configPath));

      modules.healthChecker.register("claude", createClaudeCheck());

      logger.info("daemon", "HealthChecker initialized");
    },
  });

  // 6b. MCPHealthMonitor (needs Config, Logger, HealthChecker)
  steps.push({
    name: "MCPHealthMonitor",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      const healthChecker = modules.healthChecker;
      if (!logger || !config) return;

      const mcpServers = config.brain.mcpServers;
      if (!mcpServers || Object.keys(mcpServers).length === 0) {
        logger.info("daemon", "MCPHealthMonitor skipped: no MCP servers configured");
        return;
      }

      const serverConfigs: Record<
        string,
        { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }
      > = {};
      for (const [name, server] of Object.entries(mcpServers)) {
        serverConfigs[name] = {
          command: server.command,
          args: server.args,
          env: server.env,
        };
      }

      modules.mcpHealthMonitor = new MCPHealthMonitor(serverConfigs, logger);

      if (healthChecker) {
        healthChecker.register("mcp-servers", modules.mcpHealthMonitor.createHealthCheck());
      }

      modules.mcpHealthMonitor.startPeriodic();

      logger.info("daemon", `MCPHealthMonitor initialized (${Object.keys(mcpServers).length} server(s))`);
    },
  });

  // 7. TokenTracker (needs DatabaseManager, Logger)
  steps.push({
    name: "TokenTracker",
    fn: () => {
      const dbManager = modules.dbManager;
      const logger = modules.logger;
      if (!dbManager || !logger) return;

      modules.tokenTracker = new TokenTracker(dbManager.operational, logger);
      logger.info("daemon", "TokenTracker initialized");
    },
  });

  // 7b. MetricsRegistry (no deps)
  steps.push({
    name: "MetricsRegistry",
    fn: () => {
      modules.metricsRegistry = new MetricsRegistry();
      modules.logger?.info("daemon", "MetricsRegistry initialized");
    },
  });

  // 7c. Telemetry (needs Config, Logger, MetricsRegistry)
  steps.push({
    name: "Telemetry",
    fn: async () => {
      const config = modules.config;
      const logger = modules.logger;
      if (!config || !logger) return;

      modules.telemetryProvider = await initTelemetry(config.telemetry, logger);

      if (modules.metricsRegistry) {
        modules.metricsBridge = await createMetricsBridge(
          modules.metricsRegistry,
          modules.telemetryProvider.enabled,
          logger,
        );
      }
    },
  });

  // 8. BackupManager (needs DatabaseManager, Config, Logger)
  steps.push({
    name: "BackupManager",
    fn: () => {
      const dbManager = modules.dbManager;
      const config = modules.config;
      const logger = modules.logger;
      if (!dbManager || !config || !logger) return;

      const dbConfig = {
        ...config.database,
        directory: config.database.directory || getDataDir(),
      };
      modules.backupManager = new BackupManager(dbManager, dbConfig, logger);
      logger.info("daemon", "BackupManager initialized");
    },
  });

  // 9. Health Server (needs HealthChecker, Logger)
  steps.push({
    name: "HealthServer",
    fn: () => {
      const checker = modules.healthChecker;
      const logger = modules.logger;
      if (!checker || !logger) return;

      const config = modules.config;
      const healthPort = Math.min(config?.gateway?.port ? config.gateway.port + 1000 : 9419, 65535);
      modules.healthServer = createHealthServer({
        port: healthPort,
        checker,
        logger,
      });
      modules.healthServer.start();
      logger.info("daemon", `Health server started on port ${healthPort}`);
    },
  });

  // 10. EventBus (needs DatabaseManager, Logger)
  steps.push({
    name: "EventBus",
    fn: () => {
      const dbManager = modules.dbManager;
      const logger = modules.logger;
      if (!dbManager || !logger) return;

      modules.eventBus = new EventBus(dbManager.operational, logger);
      logger.info("daemon", "EventBus initialized");
    },
  });

  // 10a. ConversationSessionStore (needs DatabaseManager, Logger)
  steps.push({
    name: "ConversationSessionStore",
    fn: () => {
      const dbManager = modules.dbManager;
      const logger = modules.logger;
      if (!dbManager || !logger) return;

      modules.conversationStore = new ConversationSessionStore(dbManager.operational, logger);
      logger.info("daemon", "ConversationSessionStore initialized");
    },
  });

  // 10b. FeedbackStore (needs DatabaseManager, EventBus, Logger)
  steps.push({
    name: "FeedbackStore",
    fn: () => {
      const dbManager = modules.dbManager;
      const eventBus = modules.eventBus;
      const logger = modules.logger;
      if (!dbManager || !logger) {
        logger?.warn("daemon", "FeedbackStore skipped: database not available");
        return;
      }

      modules.feedbackStore = new FeedbackStore(dbManager.operational, logger);
      logger.info("daemon", "FeedbackStore initialized");

      if (eventBus) {
        modules.feedbackConfidenceUnsub = subscribeFeedbackConfidenceAdjustment(eventBus, dbManager.memory, logger);
        logger.info("daemon", "Feedback confidence adjustment wired to EventBus");
      }
    },
  });

  // 10c. ApprovalManager (needs DatabaseManager, EventBus, Config, Logger)
  steps.push({
    name: "ApprovalManager",
    fn: () => {
      const dbManager = modules.dbManager;
      const eventBus = modules.eventBus;
      const config = modules.config;
      const logger = modules.logger;
      if (!dbManager || !eventBus || !config || !logger) {
        logger?.warn("daemon", "ApprovalManager skipped: missing dependencies");
        return;
      }
      try {
        modules.approvalManager = new ApprovalManager({
          db: dbManager.operational,
          logger,
          eventBus,
          config: config.security,
        });
        modules.approvalManager.start();
        logger.info("daemon", "ApprovalManager initialized and started");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `ApprovalManager skipped: ${message}`);
      }
    },
  });

  return steps;
}
