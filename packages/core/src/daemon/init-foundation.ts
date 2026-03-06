/**
 * Foundation init steps: Logger, Config, Secrets, ConfigWatcher, DatabaseManager, AuditLogger.
 * Steps 1-5b from the daemon initialization sequence.
 */

import { join } from "node:path";
import { SECRETS_DB_FILENAME, VERSION } from "@eidolon/protocol";
import { AuditLogger } from "../audit/logger.ts";
import { loadConfig } from "../config/loader.ts";
import { getConfigPath, getDataDir } from "../config/paths.ts";
import { ConfigWatcher } from "../config/watcher.ts";
import { DatabaseManager } from "../database/manager.ts";
import { createLogger } from "../logging/logger.ts";
import { LogRotator } from "../logging/rotation.ts";
import { getMasterKey } from "../secrets/master-key.ts";
import { SecretStore } from "../secrets/store.ts";
import { buildConfigReloadHandler } from "./config-reload.ts";
import { ensureDir } from "./lifecycle.ts";
import type { DaemonOptions, InitializedModules } from "./types.ts";

type InitStep = { name: string; fn: () => Promise<void> | void };

export function buildFoundationSteps(modules: InitializedModules, options?: DaemonOptions): InitStep[] {
  const steps: InitStep[] = [];

  // 1. Logger (no deps)
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

  return steps;
}
