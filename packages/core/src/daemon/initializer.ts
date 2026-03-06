/**
 * Module initialization steps for the daemon.
 *
 * buildCoreInitSteps() returns the ordered list of init steps (1-16g, 17b)
 * that initialize all core modules. Steps 17 (channels) and 18-21 (gateway)
 * are handled separately by channel-wiring.ts and gateway-wiring.ts.
 */

import { join } from "node:path";
import { Ok, SECRETS_DB_FILENAME, VERSION } from "@eidolon/protocol";
import { AuditLogger } from "../audit/logger.ts";
import { BackupManager } from "../backup/manager.ts";
import { ClaudeCodeManager } from "../claude/manager.ts";
import { WorkspacePreparer } from "../claude/workspace.ts";
import { loadConfig } from "../config/loader.ts";
import { getCacheDir, getConfigPath, getDataDir } from "../config/paths.ts";
import { ConfigWatcher } from "../config/watcher.ts";
import { buildConfigReloadHandler } from "./config-reload.ts";
import { DatabaseManager } from "../database/manager.ts";
import { DigestBuilder } from "../digest/builder.ts";
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
import { ClaudeProvider } from "../llm/claude-provider.ts";
import { LlamaCppProvider } from "../llm/llamacpp-provider.ts";
import { OllamaProvider } from "../llm/ollama-provider.ts";
import { ModelRouter } from "../llm/router.ts";
import { createLogger } from "../logging/logger.ts";
import { LogRotator } from "../logging/rotation.ts";
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
import { DocumentIndexer } from "../memory/document-indexer.ts";
import { EmbeddingModel } from "../memory/embeddings.ts";
import { MemoryExtractor } from "../memory/extractor.ts";
import { type ContextProvider, MemoryInjector } from "../memory/injector.ts";
import { CommunityDetector } from "../memory/knowledge-graph/communities.ts";
import { KGEntityStore } from "../memory/knowledge-graph/entities.ts";
import { KGRelationStore } from "../memory/knowledge-graph/relations.ts";
import { UserProfileGenerator } from "../memory/profile.ts";
import { MemorySearch } from "../memory/search.ts";
import { MemoryStore } from "../memory/store.ts";
import { MetricsRegistry } from "../metrics/prometheus.ts";
import { TokenTracker } from "../metrics/token-tracker.ts";
import { PluginLifecycleManager } from "../plugins/lifecycle.ts";
import { discoverPlugins } from "../plugins/loader.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import type { SandboxDeps } from "../plugins/sandbox.ts";
import { ResearchEngine } from "../research/engine.ts";
import { AutomationEngine } from "../scheduler/automation.ts";
import { ApprovalManager } from "../security/approval-manager.ts";
import { TaskScheduler } from "../scheduler/scheduler.ts";
import { getMasterKey } from "../secrets/master-key.ts";
import { SecretStore } from "../secrets/store.ts";
import { createMetricsBridge } from "../telemetry/metrics-bridge.ts";
import { initTelemetry } from "../telemetry/provider.ts";
import { buildEventHandler } from "./event-handlers.ts";
import { ensureDir } from "./lifecycle.ts";
import type { DaemonOptions, InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Public: build the ordered list of core init steps
// ---------------------------------------------------------------------------

export function buildCoreInitSteps(
  modules: InitializedModules,
  options?: DaemonOptions,
): Array<{ name: string; fn: () => Promise<void> | void }> {
  const steps: Array<{ name: string; fn: () => Promise<void> | void }> = [];

  // 1. Logger (no deps) -- bootstrap with minimal config before full config loads
  steps.push({
    name: "Logger",
    fn: () => {
      modules.logger = createLogger({
        level: "info",
        format: "pretty",
        directory: "",
        maxSizeMb: 50,
        maxFiles: 10,
      });
      modules.logger.info("daemon", `Eidolon v${VERSION} starting...`);
    },
  });

  // 2. Config (needs Logger)
  steps.push({
    name: "Config",
    fn: async () => {
      const result = await loadConfig(options?.configPath);
      if (!result.ok) {
        throw new Error(`Config load failed: ${result.error.message}`);
      }
      modules.config = result.value;
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
      modules.logger = createLogger(result.value.logging, { rotator });
      modules.logger.info("daemon", "Configuration loaded");
    },
  });

  // 3. SecretStore (needs Config for data dir)
  steps.push({
    name: "SecretStore",
    fn: () => {
      const masterKeyResult = getMasterKey();
      if (!masterKeyResult.ok) {
        modules.logger?.warn("daemon", `SecretStore skipped: ${masterKeyResult.error.message}`);
        return;
      }
      const dataDir = modules.config?.database.directory || getDataDir();
      ensureDir(dataDir);
      const dbPath = join(dataDir, SECRETS_DB_FILENAME);
      modules.secretStore = new SecretStore(dbPath, masterKeyResult.value, modules.logger);
      modules.logger?.info("daemon", "SecretStore initialized");
    },
  });

  // 4. Config with secrets resolved (needs SecretStore)
  steps.push({
    name: "Config (secrets resolved)",
    fn: () => {
      if (!modules.secretStore || !modules.config) return;
      const resolved = modules.secretStore.resolveSecretRefs(modules.config);
      if (resolved.ok) {
        modules.config = resolved.value;
        modules.logger?.info("daemon", "Secret references resolved in config");
      } else {
        modules.logger?.warn("daemon", `Secret resolution partial: ${resolved.error.message}`);
      }
    },
  });

  // 4b. ConfigWatcher (needs Config, Logger)
  steps.push({
    name: "ConfigWatcher",
    fn: () => {
      const logger = modules.logger;
      if (!logger) return;

      const configPath = options?.configPath ?? getConfigPath();
      const watcher = new ConfigWatcher(configPath, { logger, debounceMs: 500 });
      const handler = buildConfigReloadHandler(modules, logger);

      watcher.onChange(handler);
      watcher.start();
      modules.configWatcher = watcher;
      logger.info("daemon", `ConfigWatcher started, watching ${configPath}`);
    },
  });

  // 5. DatabaseManager (needs Config, Logger)
  steps.push({
    name: "DatabaseManager",
    fn: () => {
      const config = modules.config;
      const logger = modules.logger;
      if (!config || !logger) throw new Error("Config and Logger required for DatabaseManager");

      const dbConfig = {
        ...config.database,
        directory: config.database.directory || getDataDir(),
      };
      ensureDir(dbConfig.directory);

      modules.dbManager = new DatabaseManager(dbConfig, logger);
      const result = modules.dbManager.initialize();
      if (!result.ok) {
        throw new Error(`Database init failed: ${result.error.message}`);
      }
      logger.info("daemon", "Databases initialized (memory, operational, audit)");
    },
  });

  // 5b. AuditLogger (needs DatabaseManager, Logger)
  steps.push({
    name: "AuditLogger",
    fn: () => {
      const dbManager = modules.dbManager;
      const logger = modules.logger;
      if (!dbManager || !logger) return;

      modules.auditLogger = new AuditLogger(dbManager.audit, logger);
      logger.info("daemon", "AuditLogger initialized");
    },
  });

  // 6. HealthChecker (needs Logger)
  steps.push({
    name: "HealthChecker",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      if (!logger) throw new Error("Logger required for HealthChecker");

      modules.healthChecker = new HealthChecker(logger);

      // Register individual health checks
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

      modules.mcpHealthMonitor = new MCPHealthMonitor(serverConfigs, logger);

      // Register the aggregated MCP health check with the HealthChecker
      if (healthChecker) {
        healthChecker.register("mcp-servers", modules.mcpHealthMonitor.createHealthCheck());
      }

      // Start periodic health monitoring
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

      // Bridge existing MetricsRegistry to OTel if enabled
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

      modules.healthServer = createHealthServer({
        port: 9419,
        checker,
        logger,
      });
      modules.healthServer.start();
      logger.info("daemon", "Health server started on port 9419");
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

      // Subscribe to user:feedback events to automatically adjust memory
      // confidence scores. The subscription returns an unsubscribe function
      // stored for teardown.
      if (eventBus) {
        modules.feedbackConfidenceUnsub = subscribeFeedbackConfidenceAdjustment(
          eventBus,
          dbManager.memory,
          logger,
        );
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

  // 11. EmbeddingModel (needs Logger, Config)
  steps.push({
    name: "EmbeddingModel",
    fn: async () => {
      const logger = modules.logger;
      if (!logger) return;

      try {
        const memoryConfig = modules.config?.memory;
        modules.embeddingModel = new EmbeddingModel(logger, {
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
  steps.push({
    name: "MemoryStore",
    fn: () => {
      const dbManager = modules.dbManager;
      const logger = modules.logger;
      if (!dbManager || !logger) {
        logger?.warn("daemon", "MemoryStore skipped: database not available");
        return;
      }

      try {
        modules.memoryStore = new MemoryStore(dbManager.memory, logger);
        logger.info("daemon", "MemoryStore initialized");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `MemoryStore skipped: ${message}`);
      }
    },
  });

  // 12b. DocumentIndexer (needs DatabaseManager, MemoryStore, Config, Logger)
  steps.push({
    name: "DocumentIndexer",
    fn: async () => {
      const logger = modules.logger;
      const config = modules.config;
      const dbManager = modules.dbManager;
      const store = modules.memoryStore;

      if (!logger || !config || !dbManager || !store) {
        logger?.warn("daemon", "DocumentIndexer skipped: missing dependencies");
        return;
      }

      const indexingConfig = config.memory.indexing;
      if (!indexingConfig.enabled) {
        logger.info("daemon", "DocumentIndexer skipped: indexing not enabled in config");
        return;
      }

      if (indexingConfig.paths.length === 0) {
        logger.info("daemon", "DocumentIndexer skipped: no paths configured");
        return;
      }

      try {
        const indexer = new DocumentIndexer(dbManager.memory, store, logger, {
          fileTypes: indexingConfig.fileTypes,
          exclude: indexingConfig.exclude,
          maxFileSize: indexingConfig.maxFileSize,
        });
        modules.documentIndexer = indexer;

        // Initial scan: index all configured directories
        for (const dirPath of indexingConfig.paths) {
          const result = await indexer.indexDirectory(dirPath);
          if (result.ok) {
            logger.info(
              "daemon",
              `DocumentIndexer: indexed ${result.value.files} files (${result.value.chunks} chunks) from ${dirPath}`,
            );
          } else {
            logger.warn("daemon", `DocumentIndexer: failed to index ${dirPath}: ${result.error.message}`);
          }
        }

        // Periodic re-indexing: re-scan directories for changed files
        const intervalMs = indexingConfig.recheckIntervalSeconds * 1000;
        modules.documentIndexerInterval = setInterval(async () => {
          if (!modules.documentIndexer) return;
          for (const dirPath of indexingConfig.paths) {
            const result = await modules.documentIndexer.indexDirectory(dirPath);
            if (result.ok) {
              logger.debug("daemon", `DocumentIndexer re-scan: ${result.value.files} files from ${dirPath}`);
            } else {
              logger.warn("daemon", `DocumentIndexer re-scan failed for ${dirPath}: ${result.error.message}`);
            }
          }
        }, intervalMs);

        logger.info(
          "daemon",
          `DocumentIndexer initialized (${indexingConfig.paths.length} path(s), re-check every ${indexingConfig.recheckIntervalSeconds}s)`,
        );
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `DocumentIndexer skipped: ${message}`);
      }
    },
  });

  // 12c. UserProfileGenerator (needs DatabaseManager, Config, Logger)
  steps.push({
    name: "UserProfileGenerator",
    fn: () => {
      const dbManager = modules.dbManager;
      const config = modules.config;
      const logger = modules.logger;
      if (!dbManager || !config || !logger) {
        logger?.warn("daemon", "UserProfileGenerator skipped: requires DatabaseManager and Config");
        return;
      }
      try {
        modules.profileGenerator = new UserProfileGenerator(
          dbManager.memory,
          logger,
          config.identity.ownerName,
        );
        logger.info("daemon", `UserProfileGenerator initialized for ${config.identity.ownerName}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `UserProfileGenerator skipped: ${message}`);
      }
    },
  });

  // 13. MemorySearch (needs MemoryStore, EmbeddingModel, DatabaseManager, Logger)
  steps.push({
    name: "MemorySearch",
    fn: () => {
      const logger = modules.logger;
      const store = modules.memoryStore;
      const embedModel = modules.embeddingModel;
      const dbManager = modules.dbManager;

      if (!store || !embedModel || !dbManager || !logger) {
        logger?.warn("daemon", "MemorySearch skipped: requires MemoryStore, EmbeddingModel, and DatabaseManager");
        return;
      }

      try {
        modules.memorySearch = new MemorySearch(store, embedModel, dbManager.memory, logger);
        logger.info("daemon", "MemorySearch initialized");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `MemorySearch skipped: ${message}`);
      }
    },
  });

  // 13b. MemoryConsolidator (needs MemoryStore, EmbeddingModel, Config, Logger)
  steps.push({
    name: "MemoryConsolidator",
    fn: () => {
      const logger = modules.logger;
      const store = modules.memoryStore;
      const embedModel = modules.embeddingModel;
      const config = modules.config;

      if (!store || !embedModel || !logger) {
        logger?.warn("daemon", "MemoryConsolidator skipped: requires MemoryStore and EmbeddingModel");
        return;
      }

      try {
        const consolidationConfig = config?.memory.consolidation;
        modules.memoryConsolidator = new MemoryConsolidator(store, embedModel, logger, {
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
  steps.push({
    name: "MemoryCompressor",
    fn: () => {
      const logger = modules.logger;
      const store = modules.memoryStore;
      const config = modules.config;

      if (!store || !logger) {
        logger?.warn("daemon", "MemoryCompressor skipped: requires MemoryStore");
        return;
      }

      try {
        const consolidationConfig = config?.memory.consolidation;
        modules.memoryCompressor = new MemoryCompressor(store, logger, {
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
  steps.push({
    name: "ClaudeCodeManager",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      if (!logger) return;

      const accounts = config?.brain.accounts ?? [];
      if (accounts.length === 0) {
        logger.warn("daemon", "ClaudeCodeManager skipped: no API accounts configured in brain.accounts");
        return;
      }

      try {
        modules.claudeManager = new ClaudeCodeManager(logger);
        logger.info("daemon", "ClaudeCodeManager initialized");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `ClaudeCodeManager skipped: ${message}`);
      }
    },
  });

  // 14a. ResearchEngine (needs ClaudeCodeManager, Logger, Config)
  steps.push({
    name: "ResearchEngine",
    fn: () => {
      const logger = modules.logger;
      const claude = modules.claudeManager;
      if (!logger || !claude) {
        logger?.warn("daemon", "ResearchEngine skipped: ClaudeCodeManager not available");
        return;
      }

      try {
        const workspaceDir = join(getCacheDir(), "research");
        ensureDir(workspaceDir);

        modules.researchEngine = new ResearchEngine(claude, { workspaceDir, maxSources: 10 }, logger);
        logger.info("daemon", "ResearchEngine initialized");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `ResearchEngine skipped: ${message}`);
      }
    },
  });

  // 14b. Plugin System (needs Logger, Config)
  steps.push({
    name: "PluginSystem",
    fn: async () => {
      const logger = modules.logger;
      const config = modules.config;
      if (!logger || !config) return;

      if (!config.plugins?.enabled) {
        logger.debug("daemon", "Plugin system disabled in config");
        return;
      }

      try {
        const registry = new PluginRegistry(logger);
        modules.pluginRegistry = registry;

        const pluginDir = config.plugins.directory || "";
        const loaded = await discoverPlugins(pluginDir, logger);

        const sandboxDeps: SandboxDeps = {
          logger,
          config,
          eventBus: modules.eventBus,
          gateway: modules.gatewayServer,
          messageRouter: modules.messageRouter,
        };

        const lifecycle = new PluginLifecycleManager(
          registry,
          config.plugins,
          sandboxDeps,
          logger,
          modules.eventBus,
        );
        modules.pluginLifecycle = lifecycle;

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
  steps.push({
    name: "ModelRouter",
    fn: async () => {
      const logger = modules.logger;
      const config = modules.config;
      if (!logger || !config) return;

      const llmConfig = config.llm ?? { providers: {}, routing: {} };
      const router = new ModelRouter(llmConfig, logger);
      modules.modelRouter = router;

      // Register Claude provider (wraps existing ClaudeCodeManager)
      if (modules.claudeManager) {
        const claudeProvider = new ClaudeProvider(modules.claudeManager, logger);
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
  steps.push({
    name: "SessionSupervisor",
    fn: () => {
      const logger = modules.logger;
      if (!logger) return;

      try {
        modules.sessionSupervisor = new SessionSupervisor(logger);
        logger.info("daemon", "SessionSupervisor initialized");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("daemon", `SessionSupervisor skipped: ${message}`);
      }
    },
  });

  // 16. CognitiveLoop and PEAR pipeline dependencies
  steps.push({
    name: "CognitiveLoop",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      const eventBus = modules.eventBus;
      const supervisor = modules.sessionSupervisor;
      const dbManager = modules.dbManager;

      if (!logger || !config || !eventBus || !supervisor) {
        logger?.warn(
          "daemon",
          "CognitiveLoop skipped: missing required dependencies (Logger, Config, EventBus, or SessionSupervisor)",
        );
        return;
      }

      // 16a. CognitiveStateMachine
      modules.cognitiveStateMachine = new CognitiveStateMachine(logger);

      // 16b. PriorityEvaluator
      modules.priorityEvaluator = new PriorityEvaluator(logger);

      // 16c. EnergyBudget
      modules.energyBudget = new EnergyBudget(config.loop.energyBudget, logger);

      // 16d. RestCalculator
      modules.restCalculator = new RestCalculator(config.loop.rest, logger);

      // 16e. TaskScheduler + AutomationEngine
      if (dbManager) {
        modules.taskScheduler = new TaskScheduler(dbManager.operational, logger);
        modules.automationEngine = new AutomationEngine(
          modules.taskScheduler,
          dbManager.operational,
          logger,
        );
        logger.info("daemon", "TaskScheduler and AutomationEngine initialized");

        // Wire scheduler to emit task events via EventBus.
        // Automation tasks (action === "automation") emit scheduler:automation_due
        // with prompt/deliverTo payload. Regular tasks emit scheduler:task_due.
        const SCHEDULER_POLL_INTERVAL_MS = 30_000;
        modules.schedulerInterval = setInterval(() => {
          if (!modules.taskScheduler || !modules.eventBus) return;
          const dueResult = modules.taskScheduler.getDueTasks();
          if (!dueResult.ok) {
            logger.error("daemon", `Scheduler poll error: ${dueResult.error.message}`);
            return;
          }
          for (const task of dueResult.value) {
            if (task.action === "automation") {
              const payload = task.payload as Record<string, unknown>;
              const publishResult = modules.eventBus.publish(
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
                modules.taskScheduler.markExecuted(task.id);
              }
            } else {
              const publishResult = modules.eventBus.publish(
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
                modules.taskScheduler.markExecuted(task.id);
              }
            }
          }
        }, SCHEDULER_POLL_INTERVAL_MS);
      } else {
        logger.warn("daemon", "TaskScheduler skipped: database not available");
      }

      // 16f. MemoryExtractor (optionally wired to MemoryConsolidator)
      const extractionStrategy = config.memory.extraction.strategy;
      modules.memoryExtractor = new MemoryExtractor(logger, {
        strategy: extractionStrategy,
        consolidator: modules.memoryConsolidator,
      });
      logger.info(
        "daemon",
        `MemoryExtractor initialized (strategy: ${extractionStrategy}, consolidator: ${modules.memoryConsolidator ? "yes" : "no"})`,
      );

      // 16f-ii. WorkspacePreparer (needs Logger)
      modules.workspacePreparer = new WorkspacePreparer(logger);
      logger.info("daemon", "WorkspacePreparer initialized");

      // 16f-iii-a. Knowledge Graph stores (need memory DB)
      if (modules.dbManager) {
        modules.kgEntityStore = new KGEntityStore(modules.dbManager.memory, logger);
        modules.kgRelationStore = new KGRelationStore(modules.dbManager.memory, logger);
        modules.communityDetector = new CommunityDetector(modules.dbManager.memory, logger);
        logger.info("daemon", "Knowledge Graph stores initialized (entities, relations, communities)");
      }

      // 16f-iii. MemoryInjector (needs MemoryStore, MemorySearch, Logger)
      if (modules.memoryStore && modules.memorySearch) {
        // Build context providers list (profile, HA state, calendar, etc.)
        const contextProviders: ContextProvider[] = [];

        // Wire UserProfileGenerator as a context provider for MEMORY.md
        if (modules.profileGenerator) {
          const profileGen = modules.profileGenerator;
          contextProviders.push(() => {
            try {
              const section = profileGen.getProfileSection();
              return Ok(section);
            } catch {
              return Ok(""); // Gracefully degrade if profile generation fails
            }
          });
          logger.info("daemon", "UserProfileGenerator wired as MemoryInjector context provider");
        }

        modules.memoryInjector = new MemoryInjector(
          modules.memoryStore,
          modules.memorySearch,
          modules.kgEntityStore ?? null,
          modules.kgRelationStore ?? null,
          logger,
          { contextProviders },
          modules.communityDetector ?? null,
        );
        logger.info("daemon", "MemoryInjector initialized (KG: entities=%s, relations=%s, communities=%s)",
          { entities: !!modules.kgEntityStore, relations: !!modules.kgRelationStore, communities: !!modules.communityDetector });
      } else {
        logger.warn("daemon", "MemoryInjector skipped: MemoryStore or MemorySearch not available");
      }

      // 16g. CognitiveLoop -- build the event handler
      const handler = buildEventHandler(modules);

      // Instantiate the CognitiveLoop -- NOT started automatically.
      // Call cognitiveLoop.start() explicitly when the daemon enters run mode.
      modules.cognitiveLoop = new CognitiveLoop(
        eventBus,
        modules.cognitiveStateMachine,
        modules.priorityEvaluator,
        modules.energyBudget,
        modules.restCalculator,
        supervisor,
        logger,
        { handler },
      );

      logger.info("daemon", "CognitiveLoop instantiated (not started -- call start() to begin PEAR cycle)");
    },
  });

  // 17b. DigestBuilder (needs Config, Logger, DatabaseManager, TaskScheduler)
  steps.push({
    name: "DigestBuilder",
    fn: () => {
      const logger = modules.logger;
      const config = modules.config;
      const dbManager = modules.dbManager;
      const taskScheduler = modules.taskScheduler;

      if (!config || !logger || !dbManager) {
        logger?.warn("daemon", "DigestBuilder skipped: missing dependencies");
        return;
      }

      if (!config.digest.enabled) {
        logger.info("daemon", "DigestBuilder skipped: digest not enabled in config");
        return;
      }

      modules.digestBuilder = new DigestBuilder({
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

  return steps;
}
