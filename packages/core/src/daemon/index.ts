/**
 * EidolonDaemon -- main daemon orchestrator.
 *
 * Initializes all modules in the correct dependency order,
 * handles graceful shutdown on SIGTERM/SIGINT, and manages
 * PID file lifecycle.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EidolonConfig } from "@eidolon/protocol";
import { SECRETS_DB_FILENAME, VERSION } from "@eidolon/protocol";
import { BackupManager } from "../backup/manager.ts";
import { MessageRouter } from "../channels/router.ts";
import { TelegramChannel } from "../channels/telegram/channel.ts";
import type { TelegramConfig } from "../channels/telegram/channel.ts";
import { ClaudeCodeManager } from "../claude/manager.ts";
import { loadConfig } from "../config/loader.ts";
import { getConfigPath, getDataDir, getPidFilePath } from "../config/paths.ts";
import { DatabaseManager } from "../database/manager.ts";
import { DiscoveryBroadcaster } from "../discovery/broadcaster.ts";
import { TailscaleDetector } from "../discovery/tailscale.ts";
import { GatewayServer } from "../gateway/server.ts";
import { GPUManager } from "../gpu/manager.ts";
import { HealthChecker } from "../health/checker.ts";
import {
  createBunCheck,
  createClaudeCheck,
  createConfigCheck,
  createDatabaseCheck,
  createDiskCheck,
} from "../health/checks/index.ts";
import { createHealthServer } from "../health/server.ts";
import type { Logger } from "../logging/logger.ts";
import { createLogger } from "../logging/logger.ts";
import { LogRotator } from "../logging/rotation.ts";
import { CognitiveLoop } from "../loop/cognitive-loop.ts";
import type { EventHandler, EventHandlerResult } from "../loop/cognitive-loop.ts";
import { EnergyBudget } from "../loop/energy-budget.ts";
import { EventBus } from "../loop/event-bus.ts";
import { PriorityEvaluator } from "../loop/priority.ts";
import { RestCalculator } from "../loop/rest.ts";
import { SessionSupervisor } from "../loop/session-supervisor.ts";
import { CognitiveStateMachine } from "../loop/state-machine.ts";
import { MemoryCompressor } from "../memory/compression.ts";
import { MemoryConsolidator } from "../memory/consolidation.ts";
import { EmbeddingModel } from "../memory/embeddings.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import { MemorySearch } from "../memory/search.ts";
import { MemoryStore } from "../memory/store.ts";
import { TokenTracker } from "../metrics/token-tracker.ts";
import { MetricsRegistry } from "../metrics/prometheus.ts";
import { wireMetrics, type MetricsWiringHandle } from "../metrics/wiring.ts";
import { TaskScheduler } from "../scheduler/scheduler.ts";
import { AuditLogger } from "../audit/logger.ts";
import { getMasterKey } from "../secrets/master-key.ts";
import { SecretStore } from "../secrets/store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonOptions {
  readonly configPath?: string;
  readonly foreground?: boolean;
}

/** Tracks which modules have been initialized for reverse-order teardown. */
interface InitializedModules {
  logger?: Logger;
  config?: EidolonConfig;
  secretStore?: SecretStore;
  dbManager?: DatabaseManager;
  auditLogger?: AuditLogger;
  healthChecker?: HealthChecker;
  healthServer?: ReturnType<typeof createHealthServer>;
  tokenTracker?: TokenTracker;
  backupManager?: BackupManager;
  embeddingModel?: EmbeddingModel;
  memoryStore?: MemoryStore;
  memorySearch?: MemorySearch;
  memoryConsolidator?: MemoryConsolidator;
  memoryCompressor?: MemoryCompressor;
  claudeManager?: ClaudeCodeManager;
  eventBus?: EventBus;
  sessionSupervisor?: SessionSupervisor;
  cognitiveStateMachine?: CognitiveStateMachine;
  priorityEvaluator?: PriorityEvaluator;
  energyBudget?: EnergyBudget;
  restCalculator?: RestCalculator;
  taskScheduler?: TaskScheduler;
  memoryExtractor?: MemoryExtractor;
  cognitiveLoop?: CognitiveLoop;
  schedulerInterval?: ReturnType<typeof setInterval>;
  messageRouter?: MessageRouter;
  telegramChannel?: TelegramChannel;
  gpuManager?: GPUManager;
  metricsRegistry?: MetricsRegistry;
  metricsWiring?: MetricsWiringHandle;
  gatewayServer?: GatewayServer;
  tailscaleDetector?: TailscaleDetector;
  discoveryBroadcaster?: DiscoveryBroadcaster;
}

// ---------------------------------------------------------------------------
// EidolonDaemon
// ---------------------------------------------------------------------------

export class EidolonDaemon {
  private modules: InitializedModules = {};
  private _running = false;
  private shutdownPromise: Promise<void> | undefined;
  private signalHandlerBound = false;
  private signalHandler: (() => void) | undefined;

  get isRunning(): boolean {
    return this._running;
  }

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  async start(options?: DaemonOptions): Promise<void> {
    if (this._running) {
      throw new Error("Daemon is already running");
    }

    const initOrder: Array<{ name: string; fn: () => Promise<void> | void }> = [];

    try {
      // 1. Logger (no deps) -- bootstrap with minimal config before full config loads
      initOrder.push({
        name: "Logger",
        fn: () => {
          this.modules.logger = createLogger({
            level: "info",
            format: "pretty",
            directory: "",
            maxSizeMb: 50,
            maxFiles: 10,
          });
          this.modules.logger.info("daemon", `Eidolon v${VERSION} starting...`);
        },
      });

      // 2. Config (needs Logger)
      initOrder.push({
        name: "Config",
        fn: async () => {
          const result = await loadConfig(options?.configPath);
          if (!result.ok) {
            throw new Error(`Config load failed: ${result.error.message}`);
          }
          this.modules.config = result.value;
          // Re-create logger with config-based settings, including file rotation
          const logDir = result.value.logging.directory;
          const rotator = logDir
            ? new LogRotator({
                directory: logDir,
                filename: "daemon.log",
                maxSizeMb: result.value.logging.maxSizeMb,
                maxFiles: result.value.logging.maxFiles,
              })
            : undefined;
          this.modules.logger = createLogger(result.value.logging, { rotator });
          this.modules.logger.info("daemon", "Configuration loaded");
        },
      });

      // 3. SecretStore (needs Config for data dir)
      initOrder.push({
        name: "SecretStore",
        fn: () => {
          const masterKeyResult = getMasterKey();
          if (!masterKeyResult.ok) {
            this.modules.logger?.warn("daemon", `SecretStore skipped: ${masterKeyResult.error.message}`);
            return;
          }
          const dataDir = this.modules.config?.database.directory || getDataDir();
          ensureDir(dataDir);
          const dbPath = join(dataDir, SECRETS_DB_FILENAME);
          this.modules.secretStore = new SecretStore(dbPath, masterKeyResult.value, this.modules.logger);
          this.modules.logger?.info("daemon", "SecretStore initialized");
        },
      });

      // 4. Config with secrets resolved (needs SecretStore)
      initOrder.push({
        name: "Config (secrets resolved)",
        fn: () => {
          if (!this.modules.secretStore || !this.modules.config) return;
          const resolved = this.modules.secretStore.resolveSecretRefs(this.modules.config);
          if (resolved.ok) {
            this.modules.config = resolved.value;
            this.modules.logger?.info("daemon", "Secret references resolved in config");
          } else {
            this.modules.logger?.warn("daemon", `Secret resolution partial: ${resolved.error.message}`);
          }
        },
      });

      // 5. DatabaseManager (needs Config, Logger)
      initOrder.push({
        name: "DatabaseManager",
        fn: () => {
          const config = this.modules.config;
          const logger = this.modules.logger;
          if (!config || !logger) throw new Error("Config and Logger required for DatabaseManager");

          const dbConfig = {
            ...config.database,
            directory: config.database.directory || getDataDir(),
          };
          ensureDir(dbConfig.directory);

          this.modules.dbManager = new DatabaseManager(dbConfig, logger);
          const result = this.modules.dbManager.initialize();
          if (!result.ok) {
            throw new Error(`Database init failed: ${result.error.message}`);
          }
          logger.info("daemon", "Databases initialized (memory, operational, audit)");
        },
      });

      // 5b. AuditLogger (needs DatabaseManager, Logger)
      initOrder.push({
        name: "AuditLogger",
        fn: () => {
          const dbManager = this.modules.dbManager;
          const logger = this.modules.logger;
          if (!dbManager || !logger) return;

          this.modules.auditLogger = new AuditLogger(dbManager.audit, logger);
          logger.info("daemon", "AuditLogger initialized");
        },
      });

      // 6. HealthChecker (needs Logger)
      initOrder.push({
        name: "HealthChecker",
        fn: () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
          if (!logger) throw new Error("Logger required for HealthChecker");

          this.modules.healthChecker = new HealthChecker(logger);

          // Register individual health checks
          this.modules.healthChecker.register("bun", createBunCheck());

          if (this.modules.dbManager) {
            this.modules.healthChecker.register("databases", createDatabaseCheck(this.modules.dbManager));
          }

          const dataDir = config?.database.directory || getDataDir();
          this.modules.healthChecker.register("disk", createDiskCheck(dataDir));

          const configPath = options?.configPath ?? getConfigPath();
          this.modules.healthChecker.register("config", createConfigCheck(configPath));

          this.modules.healthChecker.register("claude", createClaudeCheck());

          logger.info("daemon", "HealthChecker initialized");
        },
      });

      // 7. TokenTracker (needs DatabaseManager, Logger)
      initOrder.push({
        name: "TokenTracker",
        fn: () => {
          const dbManager = this.modules.dbManager;
          const logger = this.modules.logger;
          if (!dbManager || !logger) return;

          this.modules.tokenTracker = new TokenTracker(dbManager.operational, logger);
          logger.info("daemon", "TokenTracker initialized");
        },
      });

      // 7b. MetricsRegistry (no deps)
      initOrder.push({
        name: "MetricsRegistry",
        fn: () => {
          this.modules.metricsRegistry = new MetricsRegistry();
          this.modules.logger?.info("daemon", "MetricsRegistry initialized");
        },
      });

      // 8. BackupManager (needs DatabaseManager, Config, Logger)
      initOrder.push({
        name: "BackupManager",
        fn: () => {
          const dbManager = this.modules.dbManager;
          const config = this.modules.config;
          const logger = this.modules.logger;
          if (!dbManager || !config || !logger) return;

          const dbConfig = {
            ...config.database,
            directory: config.database.directory || getDataDir(),
          };
          this.modules.backupManager = new BackupManager(dbManager, dbConfig, logger);
          logger.info("daemon", "BackupManager initialized");
        },
      });

      // 9. Health Server (needs HealthChecker, Logger)
      initOrder.push({
        name: "HealthServer",
        fn: () => {
          const checker = this.modules.healthChecker;
          const logger = this.modules.logger;
          if (!checker || !logger) return;

          this.modules.healthServer = createHealthServer({
            port: 9419,
            checker,
            logger,
          });
          this.modules.healthServer.start();
          logger.info("daemon", "Health server started on port 9419");
        },
      });

      // 10. EventBus (needs DatabaseManager, Logger) -- moved up since other modules depend on it
      initOrder.push({
        name: "EventBus",
        fn: () => {
          const dbManager = this.modules.dbManager;
          const logger = this.modules.logger;
          if (!dbManager || !logger) return;

          this.modules.eventBus = new EventBus(dbManager.operational, logger);
          logger.info("daemon", "EventBus initialized");
        },
      });

      // 11. EmbeddingModel (needs Logger, Config)
      initOrder.push({
        name: "EmbeddingModel",
        fn: async () => {
          const logger = this.modules.logger;
          if (!logger) return;

          try {
            const memoryConfig = this.modules.config?.memory;
            this.modules.embeddingModel = new EmbeddingModel(logger, {
              modelId: memoryConfig?.embedding.model,
              dimensions: memoryConfig?.embedding.dimensions,
            });
            // Note: we create the model but do NOT call initialize() here because
            // it downloads/loads the ONNX model which can be slow. The model will
            // be lazily initialized on first use.
            logger.info("daemon", "EmbeddingModel created (lazy initialization)");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `EmbeddingModel skipped: ${message}`);
          }
        },
      });

      // 12. MemoryStore (needs DatabaseManager, Logger)
      initOrder.push({
        name: "MemoryStore",
        fn: () => {
          const dbManager = this.modules.dbManager;
          const logger = this.modules.logger;
          if (!dbManager || !logger) {
            logger?.warn("daemon", "MemoryStore skipped: database not available");
            return;
          }

          try {
            this.modules.memoryStore = new MemoryStore(dbManager.memory, logger);
            logger.info("daemon", "MemoryStore initialized");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `MemoryStore skipped: ${message}`);
          }
        },
      });

      // 13. MemorySearch (needs MemoryStore, EmbeddingModel, DatabaseManager, Logger)
      initOrder.push({
        name: "MemorySearch",
        fn: () => {
          const logger = this.modules.logger;
          const store = this.modules.memoryStore;
          const embedModel = this.modules.embeddingModel;
          const dbManager = this.modules.dbManager;

          if (!store || !embedModel || !dbManager || !logger) {
            logger?.warn("daemon", "MemorySearch skipped: requires MemoryStore, EmbeddingModel, and DatabaseManager");
            return;
          }

          try {
            this.modules.memorySearch = new MemorySearch(store, embedModel, dbManager.memory, logger);
            logger.info("daemon", "MemorySearch initialized");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `MemorySearch skipped: ${message}`);
          }
        },
      });

      // 13b. MemoryConsolidator (needs MemoryStore, EmbeddingModel, Config, Logger)
      initOrder.push({
        name: "MemoryConsolidator",
        fn: () => {
          const logger = this.modules.logger;
          const store = this.modules.memoryStore;
          const embedModel = this.modules.embeddingModel;
          const config = this.modules.config;

          if (!store || !embedModel || !logger) {
            logger?.warn("daemon", "MemoryConsolidator skipped: requires MemoryStore and EmbeddingModel");
            return;
          }

          try {
            const consolidationConfig = config?.memory.consolidation;
            this.modules.memoryConsolidator = new MemoryConsolidator(store, embedModel, logger, {
              config: {
                enabled: consolidationConfig?.enabled ?? true,
                duplicateThreshold: consolidationConfig?.duplicateThreshold ?? 0.95,
                updateThreshold: consolidationConfig?.updateThreshold ?? 0.85,
                maxCandidates: consolidationConfig?.maxCandidates ?? 10,
              },
            });
            logger.info("daemon", "MemoryConsolidator initialized");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `MemoryConsolidator skipped: ${message}`);
          }
        },
      });

      // 13c. MemoryCompressor (needs MemoryStore, Config, Logger)
      initOrder.push({
        name: "MemoryCompressor",
        fn: () => {
          const logger = this.modules.logger;
          const store = this.modules.memoryStore;
          const config = this.modules.config;

          if (!store || !logger) {
            logger?.warn("daemon", "MemoryCompressor skipped: requires MemoryStore");
            return;
          }

          try {
            const consolidationConfig = config?.memory.consolidation;
            this.modules.memoryCompressor = new MemoryCompressor(store, logger, {
              config: {
                strategy: consolidationConfig?.compressionStrategy ?? "none",
                threshold: consolidationConfig?.compressionThreshold ?? 10,
              },
            });
            logger.info("daemon", "MemoryCompressor initialized");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `MemoryCompressor skipped: ${message}`);
          }
        },
      });

      // 14. ClaudeCodeManager (needs Logger, Config for brain.accounts)
      initOrder.push({
        name: "ClaudeCodeManager",
        fn: () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
          if (!logger) return;

          const accounts = config?.brain.accounts ?? [];
          if (accounts.length === 0) {
            logger.warn("daemon", "ClaudeCodeManager skipped: no API accounts configured in brain.accounts");
            return;
          }

          try {
            this.modules.claudeManager = new ClaudeCodeManager(logger);
            logger.info("daemon", "ClaudeCodeManager initialized");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `ClaudeCodeManager skipped: ${message}`);
          }
        },
      });

      // 15. SessionSupervisor (needs Logger)
      initOrder.push({
        name: "SessionSupervisor",
        fn: () => {
          const logger = this.modules.logger;
          if (!logger) return;

          try {
            this.modules.sessionSupervisor = new SessionSupervisor(logger);
            logger.info("daemon", "SessionSupervisor initialized");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `SessionSupervisor skipped: ${message}`);
          }
        },
      });

      // 16. CognitiveLoop and PEAR pipeline dependencies
      //     a. CognitiveStateMachine (needs Logger)
      //     b. PriorityEvaluator (needs Logger)
      //     c. EnergyBudget (needs Config.loop.energyBudget, Logger)
      //     d. RestCalculator (needs Config.loop.rest, Logger)
      //     e. TaskScheduler (needs operational DB, Logger)
      //     f. MemoryExtractor (needs Logger, extraction strategy from config)
      //     g. CognitiveLoop (needs all of the above + EventBus + SessionSupervisor)
      initOrder.push({
        name: "CognitiveLoop",
        fn: () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
          const eventBus = this.modules.eventBus;
          const supervisor = this.modules.sessionSupervisor;
          const dbManager = this.modules.dbManager;

          if (!logger || !config || !eventBus || !supervisor) {
            logger?.warn(
              "daemon",
              "CognitiveLoop skipped: missing required dependencies (Logger, Config, EventBus, or SessionSupervisor)",
            );
            return;
          }

          // 16a. CognitiveStateMachine
          this.modules.cognitiveStateMachine = new CognitiveStateMachine(logger);

          // 16b. PriorityEvaluator
          this.modules.priorityEvaluator = new PriorityEvaluator(logger);

          // 16c. EnergyBudget
          this.modules.energyBudget = new EnergyBudget(config.loop.energyBudget, logger);

          // 16d. RestCalculator
          this.modules.restCalculator = new RestCalculator(config.loop.rest, logger);

          // 16e. TaskScheduler
          if (dbManager) {
            this.modules.taskScheduler = new TaskScheduler(dbManager.operational, logger);
            logger.info("daemon", "TaskScheduler initialized");

            // Wire scheduler to emit scheduler:task_due events via EventBus
            // Check for due tasks every 30 seconds
            const SCHEDULER_POLL_INTERVAL_MS = 30_000;
            this.modules.schedulerInterval = setInterval(() => {
              if (!this.modules.taskScheduler || !this.modules.eventBus) return;
              const dueResult = this.modules.taskScheduler.getDueTasks();
              if (!dueResult.ok) {
                logger.error("daemon", `Scheduler poll error: ${dueResult.error.message}`);
                return;
              }
              for (const task of dueResult.value) {
                const publishResult = this.modules.eventBus.publish("scheduler:task_due", {
                  taskId: task.id,
                  taskName: task.name,
                  action: task.action,
                  payload: task.payload,
                }, {
                  priority: "normal",
                  source: "scheduler",
                });
                if (publishResult.ok) {
                  logger.debug("daemon", `Scheduler emitted task_due for: ${task.name}`, { taskId: task.id });
                  // Mark as executed so the next run is computed
                  this.modules.taskScheduler.markExecuted(task.id);
                }
              }
            }, SCHEDULER_POLL_INTERVAL_MS);
          } else {
            logger.warn("daemon", "TaskScheduler skipped: database not available");
          }

          // 16f. MemoryExtractor
          const extractionStrategy = config.memory.extraction.strategy;
          this.modules.memoryExtractor = new MemoryExtractor(logger, {
            strategy: extractionStrategy,
          });
          logger.info("daemon", `MemoryExtractor initialized (strategy: ${extractionStrategy})`);

          // 16g. CognitiveLoop -- build the event handler
          const handler: EventHandler = async (event, priority): Promise<EventHandlerResult> => {
            logger.info("loop-handler", `Handling event: ${event.type} (score: ${priority.score}, action: ${priority.suggestedAction})`, {
              eventId: event.id,
              eventType: event.type,
              priority: event.priority,
              suggestedAction: priority.suggestedAction,
              suggestedModel: priority.suggestedModel,
            });

            switch (event.type) {
              case "user:message": {
                logger.info("loop-handler", "User message received -- acknowledged (session routing not yet wired)", {
                  eventId: event.id,
                });
                return { success: true, tokensUsed: 0 };
              }
              case "user:voice": {
                logger.info("loop-handler", "Voice input received -- acknowledged", { eventId: event.id });
                return { success: true, tokensUsed: 0 };
              }
              case "user:approval": {
                logger.info("loop-handler", "User approval received", { eventId: event.id });
                return { success: true, tokensUsed: 0 };
              }
              case "scheduler:task_due": {
                const taskPayload = event.payload as Record<string, unknown>;
                logger.info("loop-handler", `Scheduled task due: ${String(taskPayload.taskName ?? "unknown")}`, {
                  taskId: String(taskPayload.taskId ?? ""),
                  action: String(taskPayload.action ?? ""),
                });
                return { success: true, tokensUsed: 0 };
              }
              case "system:shutdown": {
                logger.info("loop-handler", "System shutdown event received");
                return { success: true, tokensUsed: 0 };
              }
              default: {
                logger.debug("loop-handler", `Event handled (no-op): ${event.type}`, {
                  eventId: event.id,
                  priority: event.priority,
                });
                return { success: true, tokensUsed: 0 };
              }
            }
          };

          // Instantiate the CognitiveLoop -- NOT started automatically.
          // Call cognitiveLoop.start() explicitly when the daemon enters run mode.
          this.modules.cognitiveLoop = new CognitiveLoop(
            eventBus,
            this.modules.cognitiveStateMachine,
            this.modules.priorityEvaluator,
            this.modules.energyBudget,
            this.modules.restCalculator,
            supervisor,
            logger,
            { handler },
          );

          logger.info("daemon", "CognitiveLoop instantiated (not started -- call start() to begin PEAR cycle)");
        },
      });

      // 17. Channels / MessageRouter (needs EventBus, Logger, Config)
      initOrder.push({
        name: "Channels",
        fn: async () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
          const eventBus = this.modules.eventBus;

          if (!eventBus || !logger) {
            logger?.warn("daemon", "MessageRouter skipped: EventBus not available");
            return;
          }

          try {
            const dndSchedule = config?.channels.telegram?.dndSchedule;
            this.modules.messageRouter = new MessageRouter(eventBus, logger, {
              dndSchedule: dndSchedule
                ? { start: dndSchedule.start, end: dndSchedule.end }
                : undefined,
            });

            // Wire up Telegram channel if configured and enabled
            if (config?.channels.telegram?.enabled) {
              const tgConfig = config.channels.telegram;

              // botToken must be a resolved string after secret resolution (step 4).
              // If it's still a SecretRef object, the secret was not resolved -- skip.
              const botToken = tgConfig.botToken;
              if (typeof botToken !== "string") {
                logger.warn(
                  "daemon",
                  "Telegram channel skipped: botToken is an unresolved secret reference. " +
                    "Ensure the master key is set and the secret exists.",
                );
              } else {
                const telegramConfig: TelegramConfig = {
                  botToken,
                  allowedUserIds: tgConfig.allowedUserIds,
                  typingIndicator: true,
                };

                const channel = new TelegramChannel(telegramConfig, logger);

                // Wire inbound messages from Telegram -> MessageRouter -> EventBus
                channel.onMessage(async (message) => {
                  const result = this.modules.messageRouter?.routeInbound(message);
                  if (result && !result.ok) {
                    logger.error("daemon", "Failed to route Telegram inbound message", undefined, {
                      messageId: message.id,
                      error: result.error.message,
                    });
                  }
                });

                // Register channel with the router for outbound routing
                this.modules.messageRouter.registerChannel(channel);

                // Connect (start long polling)
                const connectResult = await channel.connect();
                if (connectResult.ok) {
                  this.modules.telegramChannel = channel;
                  logger.info("daemon", "Telegram channel connected");
                } else {
                  logger.error("daemon", `Telegram channel failed to connect: ${connectResult.error.message}`);
                }
              }
            } else {
              logger.info("daemon", "No channel adapters configured");
            }

            logger.info("daemon", "MessageRouter initialized");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `MessageRouter skipped: ${message}`);
          }
        },
      });

      // 18. GPUManager (needs Config, Logger)
      initOrder.push({
        name: "GPUManager",
        fn: () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
          if (!logger) return;

          const workers = config?.gpu.workers ?? [];
          if (workers.length === 0) {
            logger.info("daemon", "GPUManager skipped: no GPU workers configured");
            return;
          }

          try {
            const firstWorker = workers[0];
            if (!firstWorker) return;
            this.modules.gpuManager = new GPUManager(
              {
                url: `http://${firstWorker.host}:${firstWorker.port}`,
                apiKey: typeof firstWorker.token === "string" ? firstWorker.token : undefined,
              },
              logger,
            );
            logger.info("daemon", `GPUManager initialized (${workers.length} worker(s) configured)`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `GPUManager skipped: ${message}`);
          }
        },
      });

      // 19. GatewayServer (needs Config, Logger, EventBus)
      initOrder.push({
        name: "GatewayServer",
        fn: async () => {
          const config = this.modules.config;
          const logger = this.modules.logger;
          const eventBus = this.modules.eventBus;
          if (!config || !logger || !eventBus) {
            logger?.warn("daemon", "GatewayServer skipped: missing dependencies");
            return;
          }

          this.modules.gatewayServer = new GatewayServer({
            config: config.gateway,
            logger,
            eventBus,
            metricsRegistry: this.modules.metricsRegistry,
          });
          await this.modules.gatewayServer.start();
          logger.info("daemon", `GatewayServer started on ${config.gateway.host}:${config.gateway.port}`);
        },
      });

      // 19b. Wire gateway auth events to AuditLogger (needs EventBus, AuditLogger)
      initOrder.push({
        name: "GatewayAuditWiring",
        fn: () => {
          const eventBus = this.modules.eventBus;
          const auditLogger = this.modules.auditLogger;
          const logger = this.modules.logger;
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
      initOrder.push({
        name: "MetricsWiring",
        fn: () => {
          const metricsRegistry = this.modules.metricsRegistry;
          const eventBus = this.modules.eventBus;
          const logger = this.modules.logger;
          if (!metricsRegistry || !eventBus || !logger) return;

          this.modules.metricsWiring = wireMetrics({
            metricsRegistry,
            eventBus,
            logger,
            sessionSupervisor: this.modules.sessionSupervisor,
          });
        },
      });

      // 20. TailscaleDetector (needs Logger)
      initOrder.push({
        name: "TailscaleDetector",
        fn: () => {
          const logger = this.modules.logger;
          if (!logger) return;

          this.modules.tailscaleDetector = new TailscaleDetector(logger);
          this.modules.tailscaleDetector.start();
          logger.info("daemon", "TailscaleDetector started");
        },
      });

      // 21. DiscoveryBroadcaster (needs Config, Logger, TailscaleDetector)
      initOrder.push({
        name: "DiscoveryBroadcaster",
        fn: async () => {
          const config = this.modules.config;
          const logger = this.modules.logger;
          if (!config || !logger) return;

          this.modules.discoveryBroadcaster = new DiscoveryBroadcaster({
            logger,
            gatewayPort: config.gateway.port,
            tlsEnabled: config.gateway.tls.enabled,
            tailscale: this.modules.tailscaleDetector,
          });
          await this.modules.discoveryBroadcaster.start();
          logger.info("daemon", "DiscoveryBroadcaster started");
        },
      });

      // Execute init steps in order
      for (const step of initOrder) {
        this.modules.logger?.debug("daemon", `Initializing ${step.name}...`);
        await step.fn();
      }

      // Write PID file
      this.writePidFile();

      // Register signal handlers
      this.registerSignalHandlers();

      this._running = true;
      this.modules.logger?.info("daemon", "Eidolon daemon started successfully");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.modules.logger?.error("daemon", `Startup failed: ${message}`, err);

      // Teardown already-initialized modules in reverse
      await this.teardownModules();
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  async stop(): Promise<void> {
    if (!this._running) return;

    // Prevent double-stop
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    const logger = this.modules.logger;
    const config = this.modules.config;
    const gracefulMs = config?.daemon.gracefulShutdownMs ?? 10_000;

    logger?.info("daemon", `Graceful shutdown initiated (timeout: ${gracefulMs}ms)`);

    // 0a. Stop the CognitiveLoop if running (must happen before EventBus dispose)
    if (this.modules.cognitiveLoop?.running) {
      try {
        this.modules.cognitiveLoop.stop();
        logger?.info("daemon", "Step 0a: CognitiveLoop stopped");
      } catch (err: unknown) {
        logger?.error("daemon", "Step 0a: Error stopping CognitiveLoop", err);
      }
    }

    // 0b. Stop the scheduler polling interval
    if (this.modules.schedulerInterval) {
      try {
        clearInterval(this.modules.schedulerInterval);
        this.modules.schedulerInterval = undefined;
        logger?.info("daemon", "Step 0b: Scheduler polling interval cleared");
      } catch (err: unknown) {
        logger?.error("daemon", "Step 0b: Error clearing scheduler interval", err);
      }
    }

    // 1. Stop accepting new events -- dispose EventBus subscribers so no new
    //    handlers fire, while persisted events remain in SQLite for replay
    //    on next startup.
    if (this.modules.eventBus) {
      try {
        this.modules.eventBus.dispose();
        logger?.info("daemon", "Step 1: EventBus subscribers disposed (no new events will be processed)");
      } catch (err: unknown) {
        logger?.error("daemon", "Step 1: Error disposing EventBus subscribers", err);
      }
    } else {
      logger?.info("daemon", "Step 1: EventBus not initialized, skipping");
    }

    // 2. Signal sessions to complete -- abort all active Claude Code sessions.
    //    SessionSupervisor tracks session slots (metadata), while
    //    ClaudeCodeManager owns the actual subprocesses.
    if (this.modules.sessionSupervisor) {
      const activeSessions = this.modules.sessionSupervisor.getActive();
      if (activeSessions.length > 0) {
        logger?.info("daemon", `Step 2: Aborting ${activeSessions.length} active session(s)`);
        for (const slot of activeSessions) {
          try {
            if (this.modules.claudeManager) {
              await this.modules.claudeManager.abort(slot.sessionId);
            }
            this.modules.sessionSupervisor.unregister(slot.sessionId);
            logger?.debug("daemon", `Session aborted: ${slot.sessionId} (${slot.type})`);
          } catch (err: unknown) {
            logger?.error("daemon", `Error aborting session ${slot.sessionId}`, err);
          }
        }
      } else {
        logger?.info("daemon", "Step 2: No active sessions to abort");
      }
    } else {
      logger?.info("daemon", "Step 2: SessionSupervisor not initialized, skipping");
    }

    // 3. Disconnect all registered channels via MessageRouter.
    //    The Telegram channel has its own explicit teardown in teardownModules(),
    //    but this covers any other channels that may be registered dynamically.
    if (this.modules.messageRouter) {
      const channels = this.modules.messageRouter.getChannels();
      if (channels.length > 0) {
        logger?.info("daemon", `Step 3: Disconnecting ${channels.length} channel(s)`);
        for (const channel of channels) {
          try {
            if (channel.isConnected()) {
              await channel.disconnect();
              logger?.debug("daemon", `Channel disconnected: ${channel.id}`);
            }
          } catch (err: unknown) {
            logger?.error("daemon", `Error disconnecting channel ${channel.id}`, err);
          }
        }
      } else {
        logger?.info("daemon", "Step 3: No channels registered");
      }
    } else {
      logger?.info("daemon", "Step 3: MessageRouter not initialized, skipping");
    }

    // 4. Flush pending metrics -- capture a final snapshot of gauge values
    //    before metrics wiring is disposed in teardownModules().
    if (this.modules.metricsRegistry) {
      try {
        if (this.modules.eventBus) {
          const pendingResult = this.modules.eventBus.pendingCount();
          if (pendingResult.ok) {
            this.modules.metricsRegistry.setEventQueueDepth(pendingResult.value);
          }
        }
        if (this.modules.sessionSupervisor) {
          this.modules.metricsRegistry.setActiveSessions(
            this.modules.sessionSupervisor.getActive().length,
          );
        }
        logger?.info("daemon", "Step 4: Final metrics snapshot captured");
      } catch (err: unknown) {
        logger?.error("daemon", "Step 4: Error capturing final metrics", err);
      }
    } else {
      logger?.info("daemon", "Step 4: MetricsRegistry not available, skipping");
    }

    // 5. Publish shutdown event for any remaining listeners (best-effort).
    //    EventBus subscribers were disposed in step 1, but the event is
    //    persisted to SQLite so it can be replayed on restart if needed.
    if (this.modules.eventBus) {
      try {
        this.modules.eventBus.publish("system:shutdown", { reason: "graceful" }, {
          priority: "critical",
          source: "daemon",
        });
        logger?.debug("daemon", "Step 5: system:shutdown event persisted");
      } catch {
        // Best-effort: if EventBus DB is already closing, this is fine
      }
    }

    // 6. Teardown initialized modules in reverse, with timeout enforcement
    await Promise.race([
      this.teardownModules(),
      new Promise<void>((_, reject) =>
        setTimeout(() => {
          reject(new Error(`Graceful shutdown timed out after ${gracefulMs}ms`));
        }, gracefulMs),
      ),
    ]).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger?.error("daemon", `Shutdown timeout: ${message} -- forcing exit`);
      process.exit(1);
    });

    // 7. Remove PID file
    this.removePidFile();

    // 8. Remove signal handlers to prevent leaks on re-initialization
    this.removeSignalHandlers();

    this._running = false;
    logger?.info("daemon", "Eidolon daemon stopped");
  }

  // -----------------------------------------------------------------------
  // Module teardown (reverse order)
  // -----------------------------------------------------------------------

  private async teardownModules(): Promise<void> {
    const logger = this.modules.logger;

    // Teardown in reverse initialization order.
    // Each step is wrapped in try/catch so a failure in one does not
    // prevent the remaining modules from being cleaned up.

    // 21 -> Discovery broadcaster (stop UDP + mDNS)
    if (this.modules.discoveryBroadcaster) {
      try {
        await this.modules.discoveryBroadcaster.stop();
        logger?.info("daemon", "DiscoveryBroadcaster stopped");
      } catch (err: unknown) {
        logger?.error("daemon", "Error stopping DiscoveryBroadcaster", err);
      }
    }

    // 20 -> Tailscale detector
    if (this.modules.tailscaleDetector) {
      try {
        this.modules.tailscaleDetector.stop();
        logger?.info("daemon", "TailscaleDetector stopped");
      } catch (err: unknown) {
        logger?.error("daemon", "Error stopping TailscaleDetector", err);
      }
    }

    // 19c -> Metrics wiring (dispose before gateway so interval timers stop)
    if (this.modules.metricsWiring) {
      try {
        this.modules.metricsWiring.dispose();
        logger?.info("daemon", "MetricsWiring disposed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disposing MetricsWiring", err);
      }
    }

    // 19 -> Gateway server
    if (this.modules.gatewayServer) {
      try {
        await this.modules.gatewayServer.stop();
        logger?.info("daemon", "GatewayServer stopped");
      } catch (err: unknown) {
        logger?.error("daemon", "Error stopping GatewayServer", err);
      }
    }

    // 17 -> Telegram channel (disconnect bot polling)
    if (this.modules.telegramChannel) {
      try {
        await this.modules.telegramChannel.disconnect();
        this.modules.messageRouter?.unregisterChannel("telegram");
        logger?.info("daemon", "Telegram channel disconnected");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disconnecting Telegram channel", err);
      }
    }

    // 16 -> CognitiveLoop: stop if running (safety net for startup-failure teardown)
    if (this.modules.cognitiveLoop?.running) {
      try {
        this.modules.cognitiveLoop.stop();
        logger?.info("daemon", "CognitiveLoop stopped (teardown)");
      } catch (err: unknown) {
        logger?.error("daemon", "Error stopping CognitiveLoop", err);
      }
    }

    // 16 -> Scheduler polling interval (safety net)
    if (this.modules.schedulerInterval) {
      try {
        clearInterval(this.modules.schedulerInterval);
        this.modules.schedulerInterval = undefined;
        logger?.info("daemon", "Scheduler interval cleared (teardown)");
      } catch (err: unknown) {
        logger?.error("daemon", "Error clearing scheduler interval", err);
      }
    }

    // 15 -> SessionSupervisor: unregister any remaining sessions.
    //    Claude subprocesses were aborted in performShutdown step 2,
    //    but during startup-failure teardown performShutdown is not called.
    if (this.modules.sessionSupervisor?.hasActiveSessions()) {
      const remaining = this.modules.sessionSupervisor.getActive();
      for (const slot of remaining) {
        try {
          if (this.modules.claudeManager) {
            await this.modules.claudeManager.abort(slot.sessionId);
          }
          this.modules.sessionSupervisor.unregister(slot.sessionId);
        } catch (err: unknown) {
          logger?.error("daemon", `Error cleaning up session ${slot.sessionId}`, err);
        }
      }
      logger?.info("daemon", `SessionSupervisor: cleaned up ${remaining.length} remaining session(s)`);
    }

    // 10 -> EventBus: dispose subscribers as safety net.
    //    During normal shutdown, performShutdown already called dispose().
    //    During startup-failure teardown, this ensures cleanup.
    if (this.modules.eventBus) {
      try {
        this.modules.eventBus.dispose();
        logger?.info("daemon", "EventBus disposed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disposing EventBus", err);
      }
    }

    // 9 -> Health server
    if (this.modules.healthServer) {
      try {
        await this.modules.healthServer.stop();
        logger?.info("daemon", "Health server stopped");
      } catch (err: unknown) {
        logger?.error("daemon", "Error stopping health server", err);
      }
    }

    // 3 -> SecretStore
    if (this.modules.secretStore) {
      try {
        this.modules.secretStore.close();
        logger?.info("daemon", "SecretStore closed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error closing SecretStore", err);
      }
    }

    // 5 -> Databases (WAL checkpoint then close) -- last data-layer teardown
    if (this.modules.dbManager) {
      try {
        this.flushWalCheckpoints();
        this.modules.dbManager.close();
        logger?.info("daemon", "Databases closed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error closing databases", err);
      }
    }
  }

  // -----------------------------------------------------------------------
  // PID file management
  // -----------------------------------------------------------------------

  private writePidFile(): void {
    const pidPath = getPidFilePath();
    ensureDir(dirname(pidPath));

    // Check for symlink attack before writing PID file
    try {
      const stat = lstatSync(pidPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`PID file is a symlink: ${pidPath}`);
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    // FINDING-LOOP-018: Stale PID detection -- check if existing PID file references a running process
    if (existsSync(pidPath)) {
      try {
        const existingPid = Number.parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        if (Number.isFinite(existingPid) && existingPid > 0) {
          try {
            process.kill(existingPid, 0);
            // Process is still running
            throw new Error(`Another daemon instance is already running (PID ${existingPid})`);
          } catch (killErr: unknown) {
            if ((killErr as NodeJS.ErrnoException).code === "ESRCH") {
              // Process not found -- stale PID file, safe to overwrite
              this.modules.logger?.warn("daemon", `Stale PID file found (PID ${existingPid} not running), overwriting`);
            } else {
              throw killErr;
            }
          }
        }
      } catch (readErr: unknown) {
        // If it's the "already running" error, rethrow
        if (readErr instanceof Error && readErr.message.includes("already running")) throw readErr;
        this.modules.logger?.warn("daemon", "Could not read existing PID file, overwriting", {
          error: String(readErr),
        });
      }
    }

    // FINDING-LOOP-016: Atomic write -- write to temp file, then rename
    const tmpPath = `${pidPath}.${process.pid}.tmp`;
    writeFileSync(tmpPath, String(process.pid), "utf-8");
    renameSync(tmpPath, pidPath);
    this.modules.logger?.info("daemon", `PID file written: ${pidPath} (${process.pid})`);
  }

  // FINDING-LOOP-017: Only remove PID file if it contains our own PID
  private removePidFile(): void {
    const pidPath = getPidFilePath();
    try {
      if (existsSync(pidPath)) {
        const content = readFileSync(pidPath, "utf-8").trim();
        const filePid = Number.parseInt(content, 10);
        if (filePid !== process.pid) {
          this.modules.logger?.warn(
            "daemon",
            `PID file contains ${filePid}, not our PID ${process.pid} -- not removing`,
          );
          return;
        }
        unlinkSync(pidPath);
        this.modules.logger?.info("daemon", "PID file removed");
      }
    } catch (err: unknown) {
      this.modules.logger?.warn("daemon", "Failed to remove PID file", { error: String(err) });
    }
  }

  // -----------------------------------------------------------------------
  // Signal handlers
  // -----------------------------------------------------------------------

  private registerSignalHandlers(): void {
    if (this.signalHandlerBound) return;
    this.signalHandlerBound = true;

    const handler = (): void => {
      // Prevent re-entrant shutdown if signal received multiple times
      if (this.shutdownPromise) {
        this.modules.logger?.info("daemon", "Shutdown already in progress, ignoring repeated signal");
        return;
      }
      this.modules.logger?.info("daemon", "Received shutdown signal");
      void this.stop()
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.modules.logger?.error("daemon", `Shutdown error: ${message}`, err);
          process.exit(1);
        });
    };

    this.signalHandler = handler;
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);

    // On Windows, SIGTERM/SIGINT have limited support. The "SIGHUP" event
    // is emitted when the console window is closed. We also listen for the
    // Windows-specific "beforeExit" as a fallback for graceful shutdown.
    if (process.platform === "win32") {
      process.on("SIGHUP", handler);
    }
  }

  private removeSignalHandlers(): void {
    if (!this.signalHandlerBound || !this.signalHandler) return;
    process.removeListener("SIGTERM", this.signalHandler);
    process.removeListener("SIGINT", this.signalHandler);
    if (process.platform === "win32") {
      process.removeListener("SIGHUP", this.signalHandler);
    }
    this.signalHandlerBound = false;
    this.signalHandler = undefined;
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private flushWalCheckpoints(): void {
    try {
      const dbm = this.modules.dbManager;
      if (!dbm) return;
      dbm.memory.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      dbm.operational.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      dbm.audit.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      this.modules.logger?.warn("daemon", "WAL checkpoint flush failed");
    }
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
