/**
 * Hot-reload handler for configuration changes.
 *
 * Propagates validated config changes to the appropriate modules.
 * Non-hot-reloadable sections log a warning and require a daemon restart.
 */

import type { EidolonConfig } from "@eidolon/protocol";
import { getNestedValue } from "../config/utils.ts";
import type { GPUWorkerPoolConfig } from "../gpu/pool.ts";
import type { GPUWorkerConfig } from "../gpu/worker.ts";
import type { Logger } from "../logging/logger.ts";
import type { InitializedModules } from "./types.ts";

/**
 * Top-level config paths that support hot-reload.
 * Changes to any key NOT listed here trigger a restart warning.
 *
 * NOTE: "brain.accounts" and "security.policies" are NOT listed here because
 * they are blocked by watcher.ts LOCKED_FIELDS before config-reload ever runs.
 * Including them would be misleading since the watcher rejects those changes.
 */
const HOT_RELOADABLE_PATHS: ReadonlySet<string> = new Set([
  "identity",
  "brain.model",
  "loop.energyBudget",
  "loop.rest",
  "memory.extraction",
  "memory.dreaming",
  "learning.sources",
  "learning.relevance",
  "gpu.workers",
  "logging.level",
]);

/**
 * All top-level config paths that exist in EidolonConfig.
 * Used to detect changes in non-hot-reloadable sections.
 */
const ALL_CONFIG_SECTIONS: readonly string[] = [
  "identity",
  "brain.accounts",
  "brain.model",
  "brain.session",
  "brain.mcpServers",
  "loop.energyBudget",
  "loop.rest",
  "loop.businessHours",
  "memory.extraction",
  "memory.dreaming",
  "memory.search",
  "memory.embedding",
  "memory.retention",
  "memory.entityResolution",
  "memory.consolidation",
  "learning.enabled",
  "learning.sources",
  "learning.relevance",
  "learning.autoImplement",
  "learning.budget",
  "channels",
  "gateway",
  "gpu.workers",
  "gpu.tts",
  "gpu.stt",
  "gpu.fallback",
  "security.policies",
  "security.approval",
  "security.sandbox",
  "security.audit",
  "database",
  "logging.level",
  "logging.format",
  "logging.directory",
  "logging.maxSizeMb",
  "logging.maxFiles",
  "daemon",
  "privacy",
  "digest",
  "telemetry",
  "plugins",
  "llm",
];

function sectionChanged(oldConfig: Record<string, unknown>, newConfig: Record<string, unknown>, path: string): boolean {
  const oldVal = getNestedValue(oldConfig, path);
  const newVal = getNestedValue(newConfig, path);
  return !Bun.deepEquals(oldVal, newVal);
}

/**
 * Build a config change handler that propagates hot-reloadable sections
 * to the initialized modules and warns about non-hot-reloadable changes.
 */
export function buildConfigReloadHandler(
  modules: InitializedModules,
  logger: Logger,
): (newConfig: EidolonConfig) => void {
  return (incoming: EidolonConfig) => {
    let newConfig = incoming;
    const oldConfig = modules.config;
    if (!oldConfig) {
      // First config load -- just store it
      modules.config = newConfig;
      return;
    }

    const oldRecord = oldConfig as unknown as Record<string, unknown>;
    const newRecord = newConfig as unknown as Record<string, unknown>;

    // Detect which sections changed
    const changedSections: string[] = [];
    const nonReloadableChanges: string[] = [];

    for (const section of ALL_CONFIG_SECTIONS) {
      if (sectionChanged(oldRecord, newRecord, section)) {
        changedSections.push(section);
        if (!HOT_RELOADABLE_PATHS.has(section)) {
          nonReloadableChanges.push(section);
        }
      }
    }

    if (changedSections.length === 0) {
      logger.debug("config-reload", "Config file changed but no sections differ");
      return;
    }

    logger.info("config-reload", `Config changed: ${changedSections.join(", ")}`);

    // Warn about non-hot-reloadable changes
    if (nonReloadableChanges.length > 0) {
      logger.warn(
        "config-reload",
        `These config sections changed but require a daemon restart: ${nonReloadableChanges.join(", ")}`,
      );
    }

    // Resolve $secret references before applying
    if (modules.secretStore) {
      const resolved = modules.secretStore.resolveSecretRefs(newConfig);
      if (resolved.ok) {
        newConfig = resolved.value;
      } else {
        logger.warn("config-reload", `Secret resolution failed: ${resolved.error.message}`);
      }
    }

    // Apply hot-reloadable changes
    modules.config = newConfig;

    // 1. identity -- stored on modules.config, no module to update
    // (already applied above by setting modules.config)

    // 2. brain.accounts, brain.model -- stored on modules.config
    // ClaudeCodeManager reads config.brain on each session spawn

    // 3. loop.energyBudget
    if (sectionChanged(oldRecord, newRecord, "loop.energyBudget") && modules.energyBudget) {
      modules.energyBudget.updateConfig(newConfig.loop.energyBudget);
      logger.info("config-reload", "EnergyBudget configuration updated");
    }

    // 4. loop.rest
    if (sectionChanged(oldRecord, newRecord, "loop.rest") && modules.restCalculator) {
      modules.restCalculator.updateConfig(newConfig.loop.rest);
      logger.info("config-reload", "RestCalculator configuration updated");
    }

    // 5. memory.extraction -- stored on modules.config
    // MemoryExtractor reads strategy from config on each extraction

    // 6. memory.dreaming -- stored on modules.config
    // DreamScheduler reads schedule from config on each check

    // 7. learning.sources, learning.relevance -- stored on modules.config
    // DiscoveryEngine reads sources from config on each crawl cycle

    // 8. gpu.workers -- reconfigure the worker pool with new workers/settings
    // NOTE: The config watcher pipeline must resolve secrets (e.g. w.token)
    // before passing the config to reload handlers. If secrets are still
    // unresolved placeholders at this point, the worker will be configured
    // without authentication and health checks will fail.
    if (sectionChanged(oldRecord, newRecord, "gpu.workers") && modules.gpuWorkerPool) {
      const workers = newConfig.gpu.workers;
      const poolWorkers: GPUWorkerConfig[] = workers.map((w) => ({
        name: w.name,
        url: `http://${w.host}:${w.port}`,
        apiKey: typeof w.token === "string" ? w.token : undefined,
        capabilities: w.capabilities as readonly ("tts" | "stt" | "realtime")[],
        priority: w.priority,
        maxConcurrent: w.maxConcurrent,
      }));

      const poolConfig: GPUWorkerPoolConfig = {
        workers: poolWorkers,
        healthCheckIntervalMs: newConfig.gpu.pool.healthCheckIntervalMs,
        loadBalancing: newConfig.gpu.pool.loadBalancing,
        maxRetries: newConfig.gpu.pool.maxRetriesPerRequest,
      };

      modules.gpuWorkerPool.reconfigure(poolConfig);
      logger.info("config-reload", `GPU worker pool reconfigured with ${workers.length} worker(s)`);
    }

    // 9. security.policies -- stored on modules.config
    // ApprovalManager reads policies from config on each classification

    // 10. logging.level -- update via setLevel() which propagates to all
    // child loggers sharing the same mutable state.
    if (sectionChanged(oldRecord, newRecord, "logging.level")) {
      if (modules.logger?.setLevel) {
        modules.logger.setLevel(newConfig.logging.level);
        logger.info("config-reload", `Log level changed: ${oldConfig.logging.level} -> ${newConfig.logging.level}`);
      } else {
        logger.info(
          "config-reload",
          `Log level changed: ${oldConfig.logging.level} -> ${newConfig.logging.level}. ` +
            "Note: logger does not support dynamic level update; restart required.",
        );
      }
    }
  };
}
