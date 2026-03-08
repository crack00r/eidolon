/**
 * Memory and brain init steps: EmbeddingModel, MemoryStore, DocumentIndexer,
 * UserProfileGenerator, MemorySearch, MemoryConsolidator, MemoryCompressor,
 * ClaudeCodeManager, ResearchEngine, PluginSystem, ModelRouter.
 * Steps 11-14c from the daemon initialization sequence.
 */

import { join } from "node:path";
import { ClaudeCodeManager } from "../claude/manager.ts";
import { getCacheDir } from "../config/paths.ts";
import { ClaudeProvider } from "../llm/claude-provider.ts";
import { LlamaCppProvider } from "../llm/llamacpp-provider.ts";
import { OllamaProvider } from "../llm/ollama-provider.ts";
import { ModelRouter } from "../llm/router.ts";
import { MemoryCompressor } from "../memory/compression.ts";
import { MemoryConsolidator } from "../memory/consolidation.ts";
import { DocumentIndexer } from "../memory/document-indexer.ts";
import { DocumentWatcher } from "../memory/document-watcher.ts";
import { EmbeddingModel } from "../memory/embeddings.ts";
import { UserProfileGenerator } from "../memory/profile.ts";
import { MemorySearch } from "../memory/search.ts";
import { MemoryStore } from "../memory/store.ts";
import { PluginLifecycleManager } from "../plugins/lifecycle.ts";
import { discoverPlugins } from "../plugins/loader.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import type { SandboxDeps } from "../plugins/sandbox.ts";
import { ResearchEngine } from "../research/engine.ts";
import { ensureDir } from "./lifecycle.ts";
import type { InitializedModules } from "./types.ts";

type InitStep = { name: string; fn: () => Promise<void> | void };

export function buildMemorySteps(modules: InitializedModules): InitStep[] {
  const steps: InitStep[] = [];

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

        const watcher = new DocumentWatcher(indexer, logger, {
          fileTypes: [...indexingConfig.fileTypes],
          exclude: [...indexingConfig.exclude],
        });
        watcher.startWatching(indexingConfig.paths);
        modules.documentWatcher = watcher;

        logger.info(
          "daemon",
          `DocumentIndexer initialized (${indexingConfig.paths.length} path(s), re-check every ${indexingConfig.recheckIntervalSeconds}s, watching enabled)`,
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
        modules.profileGenerator = new UserProfileGenerator(dbManager.memory, logger, config.identity.ownerName);
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
        // Find the first enabled account (prefer api-key, fall back to oauth)
        const enabledAccount = accounts.find((a: { type: string; enabled?: boolean }) => a.enabled !== false);
        let apiKey: string | undefined;
        if (enabledAccount && enabledAccount.type === "api-key") {
          // Only pass apiKey for api-key accounts; for oauth accounts, leave it
          // undefined so ClaudeCodeManager lets the CLI use its stored OAuth session.
          const cred = enabledAccount.credential as string | { $secret: string };
          if (typeof cred === "string") {
            apiKey = cred;
          }
          // Note: { $secret: "..." } refs are resolved elsewhere; we only handle plain strings here
        }

        modules.claudeManager = new ClaudeCodeManager(logger, { apiKey });
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

        // Use lazy getters so plugins access gateway/messageRouter when
        // they actually need them, not at init time (they may be undefined here).
        const sandboxDeps: SandboxDeps = {
          logger,
          config,
          get eventBus() {
            return modules.eventBus;
          },
          get gateway() {
            return modules.gatewayServer;
          },
          get messageRouter() {
            return modules.messageRouter;
          },
        };

        const lifecycle = new PluginLifecycleManager(registry, config.plugins, sandboxDeps, logger, modules.eventBus);
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

      if (modules.claudeManager) {
        const claudeProvider = new ClaudeProvider(modules.claudeManager, logger);
        router.registerProvider(claudeProvider);
      }

      const ollamaConfig = llmConfig.providers?.ollama;
      if (ollamaConfig?.enabled) {
        const ollama = new OllamaProvider(ollamaConfig, logger, ollamaConfig.allowPrivateHosts);
        const available = await ollama.isAvailable();
        if (available) {
          router.registerProvider(ollama);
        } else {
          logger.warn("daemon", "Ollama configured but not available");
        }
      }

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

  return steps;
}
