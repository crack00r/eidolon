/**
 * EidolonDaemon -- main daemon orchestrator.
 *
 * Initializes all modules in the correct dependency order,
 * handles graceful shutdown on SIGTERM/SIGINT, and manages
 * PID file lifecycle.
 */

import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EidolonConfig, UserMessagePayload } from "@eidolon/protocol";
import { SECRETS_DB_FILENAME, VERSION } from "@eidolon/protocol";
import { AuditLogger } from "../audit/logger.ts";
import { BackupManager } from "../backup/manager.ts";
import { CalendarManager } from "../calendar/manager.ts";
import type { DiscordChannel } from "../channels/discord/channel.ts";
import type { EmailChannelConfig } from "../channels/email/channel.ts";
import { EmailChannel } from "../channels/email/channel.ts";
import { BunImapClient } from "../channels/email/imap.ts";
import { BunSmtpClient } from "../channels/email/smtp.ts";
import { MessageRouter } from "../channels/router.ts";
import type { TelegramConfig } from "../channels/telegram/channel.ts";
import { TelegramChannel } from "../channels/telegram/channel.ts";
import type { WhatsAppApiConfig } from "../channels/whatsapp/api.ts";
import { WhatsAppCloudApi } from "../channels/whatsapp/api.ts";
import type { WhatsAppChannelConfig } from "../channels/whatsapp/channel.ts";
import { WhatsAppChannel } from "../channels/whatsapp/channel.ts";
import { ClaudeCodeManager } from "../claude/manager.ts";
import { loadWorkspaceTemplates } from "../claude/templates.ts";
import { WorkspacePreparer } from "../claude/workspace.ts";
import { loadConfig } from "../config/loader.ts";
import { getConfigPath, getDataDir, getPidFilePath } from "../config/paths.ts";
import { DatabaseManager } from "../database/manager.ts";
import { DigestBuilder } from "../digest/builder.ts";
import { DiscoveryBroadcaster } from "../discovery/broadcaster.ts";
import { TailscaleDetector } from "../discovery/tailscale.ts";
import { GatewayServer } from "../gateway/server.ts";
import { GPUManager } from "../gpu/manager.ts";
import type { GPUWorkerPoolConfig } from "../gpu/pool.ts";
import { GPUWorkerPool } from "../gpu/pool.ts";
import type { GPUWorkerConfig as PoolWorkerConfig } from "../gpu/worker.ts";
import { HealthChecker } from "../health/checker.ts";
import {
  createBunCheck,
  createClaudeCheck,
  createConfigCheck,
  createDatabaseCheck,
  createDiskCheck,
} from "../health/checks/index.ts";
import { createHealthServer } from "../health/server.ts";
import { HAManager } from "../home-automation/manager.ts";
import { ClaudeProvider } from "../llm/claude-provider.ts";
import { LlamaCppProvider } from "../llm/llamacpp-provider.ts";
import { OllamaProvider } from "../llm/ollama-provider.ts";
import { ModelRouter } from "../llm/router.ts";
import type { Logger } from "../logging/logger.ts";
import { createLogger } from "../logging/logger.ts";
import { LogRotator } from "../logging/rotation.ts";
import type { EventHandler, EventHandlerResult } from "../loop/cognitive-loop.ts";
import { CognitiveLoop } from "../loop/cognitive-loop.ts";
import { EnergyBudget } from "../loop/energy-budget.ts";
import { EventBus } from "../loop/event-bus.ts";
import { PriorityEvaluator } from "../loop/priority.ts";
import { RestCalculator } from "../loop/rest.ts";
import { SessionSupervisor } from "../loop/session-supervisor.ts";
import { CognitiveStateMachine } from "../loop/state-machine.ts";
import { MCPHealthMonitor } from "../mcp/health.ts";
import { MemoryCompressor } from "../memory/compression.ts";
import { MemoryConsolidator } from "../memory/consolidation.ts";
import { EmbeddingModel } from "../memory/embeddings.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import { MemoryInjector } from "../memory/injector.ts";
import { MemorySearch } from "../memory/search.ts";
import { MemoryStore } from "../memory/store.ts";
import { MetricsRegistry } from "../metrics/prometheus.ts";
import { TokenTracker } from "../metrics/token-tracker.ts";
import { type MetricsWiringHandle, wireMetrics } from "../metrics/wiring.ts";
import { PluginLifecycleManager } from "../plugins/lifecycle.ts";
import { discoverPlugins } from "../plugins/loader.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import type { SandboxDeps } from "../plugins/sandbox.ts";
import { AutomationEngine } from "../scheduler/automation.ts";
import { TaskScheduler } from "../scheduler/scheduler.ts";
import { getMasterKey } from "../secrets/master-key.ts";
import { SecretStore } from "../secrets/store.ts";
import type { MetricsBridgeHandle } from "../telemetry/metrics-bridge.ts";
import { createMetricsBridge } from "../telemetry/metrics-bridge.ts";
import type { TelemetryProvider } from "../telemetry/provider.ts";
import { initTelemetry } from "../telemetry/provider.ts";

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
  automationEngine?: AutomationEngine;
  memoryExtractor?: MemoryExtractor;
  memoryInjector?: MemoryInjector;
  workspacePreparer?: WorkspacePreparer;
  cognitiveLoop?: CognitiveLoop;
  digestBuilder?: DigestBuilder;
  schedulerInterval?: ReturnType<typeof setInterval>;
  messageRouter?: MessageRouter;
  telegramChannel?: TelegramChannel;
  discordChannel?: DiscordChannel;
  whatsappChannel?: WhatsAppChannel;
  emailChannel?: EmailChannel;
  gpuManager?: GPUManager;
  gpuWorkerPool?: GPUWorkerPool;
  calendarManager?: CalendarManager;
  haManager?: HAManager;
  mcpHealthMonitor?: MCPHealthMonitor;
  metricsRegistry?: MetricsRegistry;
  metricsWiring?: MetricsWiringHandle;
  telemetryProvider?: TelemetryProvider;
  metricsBridge?: MetricsBridgeHandle;
  pluginRegistry?: PluginRegistry;
  pluginLifecycle?: PluginLifecycleManager;
  modelRouter?: ModelRouter;
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

      // 6b. MCPHealthMonitor (needs Config, Logger, HealthChecker)
      initOrder.push({
        name: "MCPHealthMonitor",
        fn: () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
          const healthChecker = this.modules.healthChecker;
          if (!logger || !config) return;

          const mcpServers = config.brain.mcpServers;
          if (!mcpServers || Object.keys(mcpServers).length === 0) {
            logger.info("daemon", "MCPHealthMonitor skipped: no MCP servers configured");
            return;
          }

          // Convert config mcpServers to McpServerConfig format
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

          this.modules.mcpHealthMonitor = new MCPHealthMonitor(serverConfigs, logger);

          // Register the aggregated MCP health check with the HealthChecker
          if (healthChecker) {
            healthChecker.register("mcp-servers", this.modules.mcpHealthMonitor.createHealthCheck());
          }

          // Start periodic health monitoring
          this.modules.mcpHealthMonitor.startPeriodic();

          logger.info("daemon", `MCPHealthMonitor initialized (${Object.keys(mcpServers).length} server(s))`);
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

      // 7c. Telemetry (needs Config, Logger, MetricsRegistry)
      initOrder.push({
        name: "Telemetry",
        fn: async () => {
          const config = this.modules.config;
          const logger = this.modules.logger;
          if (!config || !logger) return;

          this.modules.telemetryProvider = await initTelemetry(config.telemetry, logger);

          // Bridge existing MetricsRegistry to OTel if enabled
          if (this.modules.metricsRegistry) {
            this.modules.metricsBridge = await createMetricsBridge(
              this.modules.metricsRegistry,
              this.modules.telemetryProvider.enabled,
              logger,
            );
          }
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

      // 14b. Plugin System (needs Logger, Config)
      initOrder.push({
        name: "PluginSystem",
        fn: async () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
          if (!logger || !config) return;

          if (!config.plugins?.enabled) {
            logger.debug("daemon", "Plugin system disabled in config");
            return;
          }

          try {
            const registry = new PluginRegistry(logger);
            this.modules.pluginRegistry = registry;

            const pluginDir = config.plugins.directory || "";
            const loaded = await discoverPlugins(pluginDir, logger);

            const sandboxDeps: SandboxDeps = {
              logger,
              config,
              eventBus: this.modules.eventBus,
              gateway: this.modules.gatewayServer,
              messageRouter: this.modules.messageRouter,
            };

            const lifecycle = new PluginLifecycleManager(
              registry,
              config.plugins,
              sandboxDeps,
              logger,
              this.modules.eventBus,
            );
            this.modules.pluginLifecycle = lifecycle;

            await lifecycle.initAll(loaded);
            await lifecycle.startAll();
            logger.info("daemon", `Plugin system started (${loaded.length} plugins)`);
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `Plugin system init failed: ${message}`);
          }
        },
      });

      // 14c. ModelRouter + LLM Providers (needs Logger, Config, ClaudeCodeManager)
      initOrder.push({
        name: "ModelRouter",
        fn: async () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
          if (!logger || !config) return;

          const llmConfig = config.llm ?? { providers: {}, routing: {} };
          const router = new ModelRouter(llmConfig, logger);
          this.modules.modelRouter = router;

          // Register Claude provider (wraps existing ClaudeCodeManager)
          if (this.modules.claudeManager) {
            const claudeProvider = new ClaudeProvider(this.modules.claudeManager, logger);
            router.registerProvider(claudeProvider);
          }

          // Register Ollama provider if configured
          const ollamaConfig = llmConfig.providers?.ollama;
          if (ollamaConfig?.enabled) {
            const ollama = new OllamaProvider(ollamaConfig, logger);
            const available = await ollama.isAvailable();
            if (available) {
              router.registerProvider(ollama);
            } else {
              logger.warn("daemon", "Ollama configured but not available");
            }
          }

          // Register llama.cpp provider if configured
          const llamacppConfig = llmConfig.providers?.llamacpp;
          if (llamacppConfig?.enabled) {
            const llamacpp = new LlamaCppProvider(llamacppConfig, logger);
            const available = await llamacpp.isAvailable();
            if (available) {
              router.registerProvider(llamacpp);
            } else {
              logger.warn("daemon", "llama.cpp configured but not available");
            }
          }

          logger.info("daemon", `ModelRouter initialized with ${router.getAllProviders().length} providers`);
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

          // 16e. TaskScheduler + AutomationEngine
          if (dbManager) {
            this.modules.taskScheduler = new TaskScheduler(dbManager.operational, logger);
            this.modules.automationEngine = new AutomationEngine(
              this.modules.taskScheduler,
              dbManager.operational,
              logger,
            );
            logger.info("daemon", "TaskScheduler and AutomationEngine initialized");

            // Wire scheduler to emit task events via EventBus.
            // Automation tasks (action === "automation") emit scheduler:automation_due
            // with prompt/deliverTo payload. Regular tasks emit scheduler:task_due.
            const SCHEDULER_POLL_INTERVAL_MS = 30_000;
            this.modules.schedulerInterval = setInterval(() => {
              if (!this.modules.taskScheduler || !this.modules.eventBus) return;
              const dueResult = this.modules.taskScheduler.getDueTasks();
              if (!dueResult.ok) {
                logger.error("daemon", `Scheduler poll error: ${dueResult.error.message}`);
                return;
              }
              for (const task of dueResult.value) {
                if (task.action === "automation") {
                  const payload = task.payload as Record<string, unknown>;
                  const publishResult = this.modules.eventBus.publish(
                    "scheduler:automation_due",
                    {
                      automationId: task.id,
                      name: task.name,
                      prompt: String(payload.prompt ?? ""),
                      deliverTo: String(payload.deliverTo ?? "telegram"),
                    },
                    {
                      priority: "normal",
                      source: "scheduler",
                    },
                  );
                  if (publishResult.ok) {
                    logger.debug("daemon", `Scheduler emitted automation_due: ${task.name}`, { taskId: task.id });
                    this.modules.taskScheduler.markExecuted(task.id);
                  }
                } else {
                  const publishResult = this.modules.eventBus.publish(
                    "scheduler:task_due",
                    {
                      taskId: task.id,
                      taskName: task.name,
                      action: task.action,
                      payload: task.payload,
                    },
                    {
                      priority: "normal",
                      source: "scheduler",
                    },
                  );
                  if (publishResult.ok) {
                    logger.debug("daemon", `Scheduler emitted task_due for: ${task.name}`, { taskId: task.id });
                    this.modules.taskScheduler.markExecuted(task.id);
                  }
                }
              }
            }, SCHEDULER_POLL_INTERVAL_MS);
          } else {
            logger.warn("daemon", "TaskScheduler skipped: database not available");
          }

          // 16f. MemoryExtractor (optionally wired to MemoryConsolidator)
          const extractionStrategy = config.memory.extraction.strategy;
          this.modules.memoryExtractor = new MemoryExtractor(logger, {
            strategy: extractionStrategy,
            consolidator: this.modules.memoryConsolidator,
          });
          logger.info(
            "daemon",
            `MemoryExtractor initialized (strategy: ${extractionStrategy}, consolidator: ${this.modules.memoryConsolidator ? "yes" : "no"})`,
          );

          // 16f-ii. WorkspacePreparer (needs Logger)
          this.modules.workspacePreparer = new WorkspacePreparer(logger);
          logger.info("daemon", "WorkspacePreparer initialized");

          // 16f-iii. MemoryInjector (needs MemoryStore, MemorySearch, Logger)
          if (this.modules.memoryStore && this.modules.memorySearch) {
            this.modules.memoryInjector = new MemoryInjector(
              this.modules.memoryStore,
              this.modules.memorySearch,
              null, // KG entities -- not wired in daemon yet
              null, // KG relations -- not wired in daemon yet
              logger,
            );
            logger.info("daemon", "MemoryInjector initialized");
          } else {
            logger.warn("daemon", "MemoryInjector skipped: MemoryStore or MemorySearch not available");
          }

          // 16g. CognitiveLoop -- build the event handler
          const handler: EventHandler = async (event, priority): Promise<EventHandlerResult> => {
            logger.info(
              "loop-handler",
              `Handling event: ${event.type} (score: ${priority.score}, action: ${priority.suggestedAction})`,
              {
                eventId: event.id,
                eventType: event.type,
                priority: event.priority,
                suggestedAction: priority.suggestedAction,
                suggestedModel: priority.suggestedModel,
              },
            );

            switch (event.type) {
              case "user:message": {
                return this.handleUserMessage(event, logger);
              }
              case "user:voice": {
                return this.handleUserVoice(event, logger);
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
              case "digest:generate": {
                logger.info("loop-handler", "Digest generation triggered", { eventId: event.id });
                if (!this.modules.digestBuilder || !this.modules.messageRouter) {
                  logger.warn("loop-handler", "Digest skipped: builder or router not available");
                  return { success: true, tokensUsed: 0 };
                }
                const digestResult = this.modules.digestBuilder.build();
                if (!digestResult.ok) {
                  logger.error("loop-handler", `Digest build failed: ${digestResult.error.message}`);
                  return { success: false, tokensUsed: 0, error: digestResult.error.message };
                }
                const digest = digestResult.value;
                const digestChannel = this.modules.config?.digest.channel ?? "telegram";
                const targetChannels =
                  digestChannel === "all" ? this.modules.messageRouter.getChannels().map((c) => c.id) : [digestChannel];
                for (const chId of targetChannels) {
                  const sendResult = await this.modules.messageRouter.sendNotification(
                    {
                      id: `digest-${digest.generatedAt}`,
                      channelId: chId,
                      text: digest.markdown,
                      format: "markdown",
                    },
                    "normal",
                  );
                  if (!sendResult.ok) {
                    logger.error("loop-handler", `Digest delivery failed to ${chId}: ${sendResult.error.message}`);
                  }
                }
                // Emit digest:delivered event
                this.modules.eventBus?.publish(
                  "digest:delivered",
                  {
                    title: digest.title,
                    generatedAt: digest.generatedAt,
                    sectionCount: digest.sections.length,
                    channels: targetChannels,
                  },
                  { priority: "low", source: "digest" },
                );
                logger.info("loop-handler", `Digest delivered: ${digest.title} (${digest.sections.length} sections)`);
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
              dndSchedule: dndSchedule ? { start: dndSchedule.start, end: dndSchedule.end } : undefined,
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
            }

            // Wire up Discord channel if configured and enabled
            if (config?.channels.discord?.enabled) {
              const dcConfig = config.channels.discord;

              const botToken = dcConfig.botToken;
              if (typeof botToken !== "string") {
                logger.warn(
                  "daemon",
                  "Discord channel skipped: botToken is an unresolved secret reference. " +
                    "Ensure the master key is set and the secret exists.",
                );
              } else {
                // Discord requires a real discord.js client in production.
                // The daemon expects an IDiscordClient to be provided externally
                // or uses a default stub that logs a warning.
                logger.warn(
                  "daemon",
                  "Discord channel configured but no IDiscordClient implementation provided. " +
                    "Discord integration requires discord.js to be installed and a client adapter to be wired.",
                );
              }
            }

            // Wire up WhatsApp channel if configured and enabled
            if (config?.channels.whatsapp?.enabled) {
              const waConfig = config.channels.whatsapp;

              const accessToken = waConfig.accessToken;
              const verifyToken = waConfig.verifyToken;
              const appSecret = waConfig.appSecret;

              if (typeof accessToken !== "string" || typeof verifyToken !== "string" || typeof appSecret !== "string") {
                logger.warn(
                  "daemon",
                  "WhatsApp channel skipped: one or more secrets (accessToken, verifyToken, appSecret) " +
                    "are unresolved secret references. Ensure the master key is set and secrets exist.",
                );
              } else {
                const apiConfig: WhatsAppApiConfig = {
                  phoneNumberId: waConfig.phoneNumberId,
                  accessToken,
                };
                const api = new WhatsAppCloudApi(apiConfig, logger);

                const channelConfig: WhatsAppChannelConfig = {
                  phoneNumberId: waConfig.phoneNumberId,
                  accessToken,
                  verifyToken,
                  appSecret,
                  allowedPhoneNumbers: waConfig.allowedPhoneNumbers,
                };
                const channel = new WhatsAppChannel(channelConfig, api, logger);

                // Wire inbound messages from WhatsApp -> MessageRouter -> EventBus
                channel.onMessage(async (message) => {
                  const result = this.modules.messageRouter?.routeInbound(message);
                  if (result && !result.ok) {
                    logger.error("daemon", "Failed to route WhatsApp inbound message", undefined, {
                      messageId: message.id,
                      error: result.error.message,
                    });
                  }
                });

                // Register channel with the router for outbound routing
                this.modules.messageRouter.registerChannel(channel);

                // Connect (webhook mode -- just marks as ready)
                const connectResult = await channel.connect();
                if (connectResult.ok) {
                  this.modules.whatsappChannel = channel;
                  logger.info("daemon", "WhatsApp channel connected");
                } else {
                  logger.error("daemon", `WhatsApp channel failed to connect: ${connectResult.error.message}`);
                }
              }
            }

            // Wire up Email channel if configured and enabled
            if (config?.channels.email?.enabled) {
              const emailConfig = config.channels.email;

              const imapPassword = emailConfig.imap.password;
              const smtpPassword = emailConfig.smtp.password;

              if (typeof imapPassword !== "string" || typeof smtpPassword !== "string") {
                logger.warn(
                  "daemon",
                  "Email channel skipped: one or more secrets (imap.password, smtp.password) " +
                    "are unresolved secret references. Ensure the master key is set and secrets exist.",
                );
              } else {
                const imapClient = new BunImapClient({
                  host: emailConfig.imap.host,
                  port: emailConfig.imap.port,
                  tls: emailConfig.imap.tls,
                  user: emailConfig.imap.user,
                  password: imapPassword,
                  folder: emailConfig.imap.folder,
                });

                const smtpClient = new BunSmtpClient({
                  host: emailConfig.smtp.host,
                  port: emailConfig.smtp.port,
                  tls: emailConfig.smtp.tls,
                  user: emailConfig.smtp.user,
                  password: smtpPassword,
                  from: emailConfig.smtp.from,
                });

                const channelConfig: EmailChannelConfig = {
                  imap: {
                    host: emailConfig.imap.host,
                    port: emailConfig.imap.port,
                    tls: emailConfig.imap.tls,
                    user: emailConfig.imap.user,
                    password: imapPassword,
                    pollIntervalMs: emailConfig.imap.pollIntervalMs,
                    folder: emailConfig.imap.folder,
                  },
                  smtp: {
                    host: emailConfig.smtp.host,
                    port: emailConfig.smtp.port,
                    tls: emailConfig.smtp.tls,
                    user: emailConfig.smtp.user,
                    password: smtpPassword,
                    from: emailConfig.smtp.from,
                  },
                  allowedSenders: emailConfig.allowedSenders,
                  subjectPrefix: emailConfig.subjectPrefix,
                  maxAttachmentSizeMb: emailConfig.maxAttachmentSizeMb,
                  threadingEnabled: emailConfig.threadingEnabled,
                };

                const channel = new EmailChannel(channelConfig, imapClient, smtpClient, logger);

                // Wire inbound messages from Email -> MessageRouter -> EventBus
                channel.onMessage(async (message) => {
                  const result = this.modules.messageRouter?.routeInbound(message);
                  if (result && !result.ok) {
                    logger.error("daemon", "Failed to route Email inbound message", undefined, {
                      messageId: message.id,
                      error: result.error.message,
                    });
                  }
                });

                // Register channel with the router for outbound routing
                this.modules.messageRouter.registerChannel(channel);

                // Connect (IMAP + SMTP)
                const connectResult = await channel.connect();
                if (connectResult.ok) {
                  this.modules.emailChannel = channel;
                  logger.info("daemon", "Email channel connected");
                } else {
                  logger.error("daemon", `Email channel failed to connect: ${connectResult.error.message}`);
                }
              }
            }

            if (
              !config?.channels.telegram?.enabled &&
              !config?.channels.discord?.enabled &&
              !config?.channels.whatsapp?.enabled &&
              !config?.channels.email?.enabled
            ) {
              logger.info("daemon", "No channel adapters configured");
            }

            logger.info("daemon", "MessageRouter initialized");
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.warn("daemon", `MessageRouter skipped: ${message}`);
          }
        },
      });

      // 17b. DigestBuilder (needs Config, Logger, DatabaseManager, TaskScheduler)
      initOrder.push({
        name: "DigestBuilder",
        fn: () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
          const dbManager = this.modules.dbManager;
          const taskScheduler = this.modules.taskScheduler;

          if (!config || !logger || !dbManager) {
            logger?.warn("daemon", "DigestBuilder skipped: missing dependencies");
            return;
          }

          if (!config.digest.enabled) {
            logger.info("daemon", "DigestBuilder skipped: digest not enabled in config");
            return;
          }

          this.modules.digestBuilder = new DigestBuilder({
            operationalDb: dbManager.operational,
            memoryDb: dbManager.memory,
            logger,
            config: config.digest,
          });
          logger.info("daemon", "DigestBuilder initialized");

          // Register a recurring scheduled task for daily digest delivery
          if (taskScheduler) {
            const listResult = taskScheduler.list();
            const alreadyExists = listResult.ok && listResult.value.some((t) => t.action === "digest:generate");
            if (!alreadyExists) {
              const createResult = taskScheduler.create({
                name: "Daily Digest",
                type: "recurring",
                cron: config.digest.time,
                action: "digest:generate",
                payload: {},
              });
              if (createResult.ok) {
                logger.info("daemon", `Digest scheduled daily at ${config.digest.time} (${config.digest.timezone})`);
              } else {
                logger.error("daemon", `Failed to schedule digest: ${createResult.error.message}`);
              }
            } else {
              logger.debug("daemon", "Digest scheduled task already exists");
            }
          }
        },
      });

      // 18. GPUManager + GPUWorkerPool (needs Config, Logger)
      initOrder.push({
        name: "GPUManager",
        fn: () => {
          const logger = this.modules.logger;
          const config = this.modules.config;
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
            this.modules.gpuManager = new GPUManager(
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

            this.modules.gpuWorkerPool = new GPUWorkerPool(poolConfig, logger);
            this.modules.gpuWorkerPool.startHealthChecks();

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

      // 19a. Wire GPU pool RPC handlers to GatewayServer (needs GatewayServer, GPUWorkerPool)
      initOrder.push({
        name: "GatewayGpuWiring",
        fn: () => {
          const gatewayServer = this.modules.gatewayServer;
          const gpuPool = this.modules.gpuWorkerPool;
          const logger = this.modules.logger;
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

      // 19a-wa. Wire WhatsApp webhook handler to GatewayServer (needs GatewayServer, WhatsAppChannel)
      initOrder.push({
        name: "GatewayWhatsAppWiring",
        fn: () => {
          const gatewayServer = this.modules.gatewayServer;
          const whatsappChannel = this.modules.whatsappChannel;
          const config = this.modules.config;
          const logger = this.modules.logger;

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
      initOrder.push({
        name: "CalendarManager",
        fn: async () => {
          const db = this.modules.dbManager?.operational;
          const logger = this.modules.logger;
          const eventBus = this.modules.eventBus;
          const config = this.modules.config;
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

          this.modules.calendarManager = calendarManager;
          logger.info("daemon", "CalendarManager initialized");
        },
      });

      // 19a-cal-gw. Wire calendar gateway RPC handlers (needs Gateway, CalendarManager)
      initOrder.push({
        name: "GatewayCalendarWiring",
        fn: () => {
          const gatewayServer = this.modules.gatewayServer;
          const calendarManager = this.modules.calendarManager;
          const logger = this.modules.logger;
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
            const event = params as Omit<import("@eidolon/protocol").CalendarEvent, "id" | "syncedAt">;
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
      initOrder.push({
        name: "HAManager",
        fn: async () => {
          const db = this.modules.dbManager?.operational;
          const logger = this.modules.logger;
          const eventBus = this.modules.eventBus;
          const config = this.modules.config;
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
            embeddingModel: this.modules.embeddingModel,
          });

          const initResult = await haManager.initialize();
          if (!initResult.ok) {
            logger.warn("daemon", `HAManager init failed: ${initResult.error.message}`);
            return;
          }

          this.modules.haManager = haManager;
          logger.info("daemon", "HAManager initialized");
        },
      });

      // 19a-ha-gw. Wire HA gateway RPC handlers (needs Gateway, HAManager)
      initOrder.push({
        name: "GatewayHAWiring",
        fn: () => {
          const gatewayServer = this.modules.gatewayServer;
          const haManager = this.modules.haManager;
          const logger = this.modules.logger;
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

      // 19d. Wire plugin + LLM RPC handlers to gateway
      initOrder.push({
        name: "PluginLlmGatewayWiring",
        fn: () => {
          const gateway = this.modules.gatewayServer;
          const logger = this.modules.logger;
          if (!gateway || !logger) return;

          // Plugin RPC handlers
          const registry = this.modules.pluginRegistry;
          if (registry) {
            gateway.registerHandler("plugin.list" as never, async () => registry.getAll());
            gateway.registerHandler("plugin.info" as never, async (params: unknown) => {
              const { name } = params as { name: string };
              return registry.get(name) ?? null;
            });
            logger.info("daemon", "Plugin RPC handlers wired to gateway");
          }

          // LLM RPC handlers
          const router = this.modules.modelRouter;
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

      // Start the CognitiveLoop (PEAR cycle) in the background.
      // start() returns a promise that resolves when stop() is called.
      if (this.modules.cognitiveLoop) {
        this.modules.cognitiveLoop.start().catch((err: unknown) => {
          this.modules.logger?.error(
            "daemon",
            `CognitiveLoop crashed: ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        });
        this.modules.logger?.info("daemon", "CognitiveLoop started (PEAR cycle active)");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.modules.logger?.error("daemon", `Startup failed: ${message}`, err);

      // Teardown already-initialized modules in reverse
      await this.teardownModules();
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Event Handlers
  // -----------------------------------------------------------------------

  /**
   * Handle user:message events. Invokes Claude Code with memory context
   * and routes the response back to the originating channel.
   */
  private async handleUserMessage(
    event: { readonly id: string; readonly payload: unknown },
    logger: Logger,
  ): Promise<EventHandlerResult> {
    try {
      // Runtime-validate payload fields (event.payload is typed as unknown)
      const rawPayload = event.payload as Record<string, unknown>;
      const channelId = typeof rawPayload.channelId === "string" ? rawPayload.channelId : undefined;
      const userId = typeof rawPayload.userId === "string" ? rawPayload.userId : undefined;
      const text = typeof rawPayload.text === "string" ? rawPayload.text : undefined;

      if (!channelId || !userId) {
        logger.warn("loop-handler", "Invalid user:message payload: missing channelId or userId", {
          eventId: event.id,
        });
        return { success: false, tokensUsed: 0, error: "Invalid payload: missing channelId or userId" };
      }

      if (!text || text.trim().length === 0) {
        logger.debug("loop-handler", "Empty user message, skipping", { eventId: event.id });
        return { success: true, tokensUsed: 0 };
      }

      logger.info("loop-handler", "Processing user message", {
        eventId: event.id,
        channelId,
        userId,
        textLength: text.length,
      });

      const config = this.modules.config;
      const claudeManager = this.modules.claudeManager;
      const workspacePreparer = this.modules.workspacePreparer;
      const messageRouter = this.modules.messageRouter;

      if (!config || !claudeManager || !workspacePreparer || !messageRouter) {
        logger.warn(
          "loop-handler",
          "Cannot process message: missing modules (config, claudeManager, workspacePreparer, or messageRouter)",
        );
        return { success: false, tokensUsed: 0, error: "Required modules not initialized" };
      }

      const sessionId = `msg-${randomUUID()}`;

      // 1. Generate MEMORY.md content via MemoryInjector
      let memoryMdContent = "# Memory Context\n\nNo memory system available.\n";
      if (this.modules.memoryInjector) {
        const memResult = await this.modules.memoryInjector.generateMemoryMd({
          query: text,
          staticContext: `User: ${config.identity.ownerName}\nTime: ${new Date().toISOString()}`,
        });
        if (memResult.ok) {
          memoryMdContent = memResult.value;
        } else {
          logger.warn("loop-handler", `MemoryInjector failed: ${memResult.error.message}`);
        }
      }

      // 2. Load workspace templates and prepare workspace
      const templateResult = await loadWorkspaceTemplates({
        ownerName: config.identity.ownerName,
        currentTime: new Date().toISOString(),
        channelId,
        sessionType: "main",
      });

      let claudeMd: string;
      let soulMd: string | undefined;
      if (templateResult.ok) {
        claudeMd = templateResult.value.claudeMd;
        soulMd = templateResult.value.soulMd || undefined;
      } else {
        // Fallback to minimal inline content if templates are not found
        logger.warn("loop-handler", `Template loading failed, using fallback: ${templateResult.error.message}`);
        claudeMd = [
          "# Eidolon System Instructions",
          "",
          `You are Eidolon, an autonomous personal AI assistant for ${config.identity.ownerName}.`,
          `Current time: ${new Date().toISOString()}`,
          "",
          "## Rules",
          "- Read MEMORY.md for context about the user and previous conversations.",
          "- When you learn something new about the user, state it explicitly.",
          "- When making decisions, explain your reasoning.",
          "- For external actions, always confirm with the user first.",
          "",
          `## Current Session`,
          `- Channel: ${channelId}`,
          `- Session type: main`,
          "",
        ].join("\n");
      }

      const prepareResult = await workspacePreparer.prepare(sessionId, {
        claudeMd,
        soulMd,
        additionalFiles: {
          "MEMORY.md": memoryMdContent,
        },
      });

      if (!prepareResult.ok) {
        logger.error("loop-handler", `Workspace preparation failed: ${prepareResult.error.message}`);
        return { success: false, tokensUsed: 0, error: prepareResult.error.message };
      }

      const workspaceDir = prepareResult.value;

      // Steps 3-7 are wrapped in try/finally to guarantee workspace cleanup
      try {
        // 3. Invoke Claude Code
        const responseChunks: string[] = [];
        let totalTokens = 0;

        for await (const streamEvent of claudeManager.run(text, {
          sessionId,
          workspaceDir,
          model: config.brain.model.default,
          timeoutMs: config.brain.session.timeoutMs,
        })) {
          switch (streamEvent.type) {
            case "text": {
              if (streamEvent.content) {
                responseChunks.push(streamEvent.content);
              }
              break;
            }
            case "error": {
              logger.error("loop-handler", `Claude stream error: ${streamEvent.error ?? "unknown"}`, undefined, {
                sessionId,
              });
              break;
            }
            case "done": {
              // done events don't carry token info in StreamEvent, but we track what we can
              break;
            }
            default:
              break;
          }
        }

        const responseText = responseChunks.join("");

        if (responseText.length === 0) {
          logger.warn("loop-handler", "Claude returned empty response", { sessionId });
          return { success: true, tokensUsed: 0 };
        }

        // 4. Route response back to the originating channel
        const outboundResult = await messageRouter.routeOutbound({
          id: `resp-${randomUUID()}`,
          channelId,
          text: responseText,
          format: "markdown",
          replyToId: event.id,
        });

        if (!outboundResult.ok) {
          logger.error("loop-handler", `Failed to send response: ${outboundResult.error.message}`, undefined, {
            channelId,
          });
        }

        // 5. Fire-and-forget memory extraction
        if (this.modules.memoryExtractor) {
          this.modules.memoryExtractor
            .extract({
              userMessage: text,
              assistantResponse: responseText,
              sessionId,
              timestamp: Date.now(),
            })
            .then((extractResult) => {
              if (extractResult.ok) {
                logger.debug("loop-handler", `Extracted ${extractResult.value.length} memories from conversation`, {
                  sessionId,
                });
              } else {
                logger.warn("loop-handler", `Memory extraction failed: ${extractResult.error.message}`);
              }
            })
            .catch((err: unknown) => {
              logger.warn(
                "loop-handler",
                `Memory extraction threw: ${err instanceof Error ? err.message : String(err)}`,
              );
            });
        }

        // 6. Record token usage (estimate based on text lengths)
        if (this.modules.tokenTracker) {
          const estimatedInput = Math.ceil(text.length / 4);
          const estimatedOutput = Math.ceil(responseText.length / 4);
          totalTokens = estimatedInput + estimatedOutput;
          this.modules.tokenTracker.record({
            sessionId,
            sessionType: "main",
            model: config.brain.model.default,
            inputTokens: estimatedInput,
            outputTokens: estimatedOutput,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: 0,
            timestamp: Date.now(),
          });
        }

        logger.info("loop-handler", "User message processed successfully", {
          sessionId,
          responseLength: responseText.length,
          tokensUsed: totalTokens,
        });

        return { success: true, tokensUsed: totalTokens };
      } catch (claudeErr: unknown) {
        const errMsg = claudeErr instanceof Error ? claudeErr.message : String(claudeErr);
        logger.error("loop-handler", `Message processing failed: ${errMsg}`);
        return { success: false, tokensUsed: 0, error: errMsg };
      } finally {
        // 7. Always clean up workspace, even on error
        workspacePreparer.cleanup(sessionId);
      }
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("loop-handler", `user:message handler failed: ${errMsg}`);
      return { success: false, tokensUsed: 0, error: errMsg };
    }
  }

  /**
   * Handle user:voice events. Extracts text from the payload (if present)
   * and delegates to the text message handler. If no text is available
   * (pure audio), logs a warning that STT is not wired yet.
   */
  private async handleUserVoice(
    event: { readonly id: string; readonly payload: unknown },
    logger: Logger,
  ): Promise<EventHandlerResult> {
    try {
      // Runtime-validate payload fields
      const rawPayload = event.payload as Record<string, unknown>;
      const channelId = typeof rawPayload.channelId === "string" ? rawPayload.channelId : undefined;
      const userId = typeof rawPayload.userId === "string" ? rawPayload.userId : undefined;
      const text = typeof rawPayload.text === "string" ? rawPayload.text : undefined;

      if (!channelId || !userId) {
        logger.warn("loop-handler", "Voice payload missing channelId or userId, using defaults", {
          eventId: event.id,
          hasChannelId: !!channelId,
          hasUserId: !!userId,
        });
      }

      if (!text || text.trim().length === 0) {
        logger.warn("loop-handler", "Voice input received without transcription -- STT not wired yet", {
          eventId: event.id,
        });
        return { success: true, tokensUsed: 0 };
      }

      // Delegate to the text message handler with the transcribed text
      logger.info("loop-handler", "Voice input with transcription, delegating to message handler", {
        eventId: event.id,
        textLength: text.length,
      });

      const syntheticPayload: UserMessagePayload = {
        channelId: channelId ?? "voice",
        userId: userId ?? "unknown",
        text,
      };

      return this.handleUserMessage({ id: event.id, payload: syntheticPayload }, logger);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("loop-handler", `user:voice handler failed: ${errMsg}`);
      return { success: false, tokensUsed: 0, error: errMsg };
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
          this.modules.metricsRegistry.setActiveSessions(this.modules.sessionSupervisor.getActive().length);
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
        this.modules.eventBus.publish(
          "system:shutdown",
          { reason: "graceful" },
          {
            priority: "critical",
            source: "daemon",
          },
        );
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

    // 19a-cal -> CalendarManager (stop sync intervals, disconnect providers)
    if (this.modules.calendarManager) {
      try {
        await this.modules.calendarManager.dispose();
        logger?.info("daemon", "CalendarManager disposed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disposing CalendarManager", err);
      }
    }

    // 19a-ha -> HAManager (stop sync interval)
    if (this.modules.haManager) {
      try {
        await this.modules.haManager.dispose();
        logger?.info("daemon", "HAManager disposed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disposing HAManager", err);
      }
    }

    // 14b -> Plugin system (stop and destroy all plugins)
    if (this.modules.pluginLifecycle) {
      try {
        await this.modules.pluginLifecycle.stopAll();
        await this.modules.pluginLifecycle.destroyAll();
        logger?.info("daemon", "Plugin lifecycle stopped and destroyed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error stopping plugin lifecycle", err);
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

    // 17 -> Discord channel (disconnect bot)
    if (this.modules.discordChannel) {
      try {
        await this.modules.discordChannel.disconnect();
        this.modules.messageRouter?.unregisterChannel("discord");
        logger?.info("daemon", "Discord channel disconnected");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disconnecting Discord channel", err);
      }
    }

    // 17 -> WhatsApp channel (disconnect)
    if (this.modules.whatsappChannel) {
      try {
        await this.modules.whatsappChannel.disconnect();
        this.modules.messageRouter?.unregisterChannel("whatsapp");
        logger?.info("daemon", "WhatsApp channel disconnected");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disconnecting WhatsApp channel", err);
      }
    }

    // 17 -> Email channel (disconnect)
    if (this.modules.emailChannel) {
      try {
        await this.modules.emailChannel.disconnect();
        this.modules.messageRouter?.unregisterChannel("email");
        logger?.info("daemon", "Email channel disconnected");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disconnecting Email channel", err);
      }
    }

    // 7c -> MetricsBridge (dispose before telemetry shutdown)
    if (this.modules.metricsBridge) {
      try {
        this.modules.metricsBridge.dispose();
        logger?.info("daemon", "MetricsBridge disposed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disposing MetricsBridge", err);
      }
    }

    // 7c -> TelemetryProvider (flush pending spans/metrics)
    if (this.modules.telemetryProvider) {
      try {
        await this.modules.telemetryProvider.shutdown();
        logger?.info("daemon", "TelemetryProvider shut down");
      } catch (err: unknown) {
        logger?.error("daemon", "Error shutting down TelemetryProvider", err);
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

    // 18b -> GPUWorkerPool: stop health checks
    if (this.modules.gpuWorkerPool) {
      try {
        this.modules.gpuWorkerPool.dispose();
        logger?.info("daemon", "GPUWorkerPool disposed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disposing GPUWorkerPool", err);
      }
    }

    // 6b -> MCPHealthMonitor
    if (this.modules.mcpHealthMonitor) {
      try {
        this.modules.mcpHealthMonitor.dispose();
        logger?.info("daemon", "MCPHealthMonitor disposed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error disposing MCPHealthMonitor", err);
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
