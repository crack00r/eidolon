/**
 * Hot-reload handler for configuration changes.
 *
 * Propagates validated config changes to the appropriate modules.
 * Non-hot-reloadable sections log a warning and require a daemon restart.
 */

import type { EidolonConfig } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { InitializedModules } from "./types.ts";

/**
 * Top-level config paths that support hot-reload.
 * Changes to any key NOT listed here trigger a restart warning.
 */
const HOT_RELOADABLE_PATHS: ReadonlySet<string> = new Set([
  "identity",
  "brain.accounts",
  "brain.model",
  "loop.energyBudget",
  "loop.rest",
  "memory.extraction",
  "memory.dreaming",
  "learning.sources",
  "learning.relevance",
  "gpu.workers",
  "security.policies",
  "logging.level",
]);

/** Resolve a dot-separated path to a value in a nested object. */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

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

/** Check if a section value changed between old and new config. */
function sectionChanged(oldConfig: Record<string, unknown>, newConfig: Record<string, unknown>, path: string): boolean {
  const oldVal = getNestedValue(oldConfig, path);
  const newVal = getNestedValue(newConfig, path);
  return JSON.stringify(oldVal) !== JSON.stringify(newVal);
}

/**
 * Build a config change handler that propagates hot-reloadable sections
 * to the initialized modules and warns about non-hot-reloadable changes.
 */
export function buildConfigReloadHandler(
  modules: InitializedModules,
  logger: Logger,
): (newConfig: EidolonConfig) => void {
  return (newConfig: EidolonConfig) => {
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

    // 8. gpu.workers -- stored on modules.config
    // GPUManager reads workers list from config on health check

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
