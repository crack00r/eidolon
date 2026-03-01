/**
 * EidolonDaemon -- main daemon orchestrator.
 *
 * Initializes all modules in the correct dependency order,
 * handles graceful shutdown on SIGTERM/SIGINT, and manages
 * PID file lifecycle.
 */

import { existsSync, lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EidolonConfig } from "@eidolon/protocol";
import { SECRETS_DB_FILENAME, VERSION } from "@eidolon/protocol";
import { BackupManager } from "../backup/manager.js";
import { loadConfig } from "../config/loader.js";
import { getDataDir, getPidFilePath } from "../config/paths.js";
import { DatabaseManager } from "../database/manager.js";
import { HealthChecker } from "../health/checker.js";
import { createHealthServer } from "../health/server.js";
import type { Logger } from "../logging/logger.js";
import { createLogger } from "../logging/logger.js";
import { TokenTracker } from "../metrics/token-tracker.js";
import { getMasterKey } from "../secrets/master-key.js";
import { SecretStore } from "../secrets/store.js";

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
  healthChecker?: HealthChecker;
  healthServer?: ReturnType<typeof createHealthServer>;
  tokenTracker?: TokenTracker;
  backupManager?: BackupManager;
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
          // Re-create logger with config-based settings
          this.modules.logger = createLogger(result.value.logging);
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
          this.modules.secretStore = new SecretStore(dbPath, masterKeyResult.value);
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

      // 6. HealthChecker (needs Logger)
      initOrder.push({
        name: "HealthChecker",
        fn: () => {
          const logger = this.modules.logger;
          if (!logger) throw new Error("Logger required for HealthChecker");

          this.modules.healthChecker = new HealthChecker(logger);

          // Register database health check
          if (this.modules.dbManager) {
            const dbManager = this.modules.dbManager;
            this.modules.healthChecker.register("databases", async () => {
              try {
                dbManager.getStats();
                return { name: "databases", status: "pass", message: "All databases accessible" };
              } catch {
                return { name: "databases", status: "fail", message: "Database access failed" };
              }
            });
          }

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

      // 10-18: Higher-phase modules (placeholder logging)
      const placeholders = [
        "EmbeddingModel (Phase 2)",
        "MemoryStore (Phase 2)",
        "MemorySearch (Phase 2)",
        "ClaudeCodeManager (Phase 1)",
        "EventBus (Phase 3)",
        "SessionSupervisor (Phase 3)",
        "CognitiveLoop (Phase 3)",
        "Channels (Phase 4)",
        "Gateway (Phase 7)",
        "GPUManager (Phase 6)",
      ];

      for (const name of placeholders) {
        initOrder.push({
          name,
          fn: () => {
            this.modules.logger?.info("daemon", `${name} -- wiring deferred`);
          },
        });
      }

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

    // 1. Stop accepting new events (EventBus.pause) -- placeholder
    logger?.info("daemon", "Step 1: Stop accepting new events");

    // 2. Signal sessions to complete current turn -- placeholder
    logger?.info("daemon", "Step 2: Signal sessions to complete");

    // 3-4. Wait for sessions, then force-terminate -- placeholder
    logger?.info("daemon", "Step 3-4: Waiting for sessions to finish");

    // 5. Flush pending metrics -- placeholder
    logger?.info("daemon", "Step 5: Flush metrics");

    // 6. Close channels -- placeholder
    logger?.info("daemon", "Step 6: Close channels");

    // 7. Teardown initialized modules in reverse
    await this.teardownModules();

    // 8. Remove PID file
    this.removePidFile();

    // 9. Remove signal handlers to prevent leaks on re-initialization
    this.removeSignalHandlers();

    this._running = false;
    logger?.info("daemon", "Eidolon daemon stopped");
  }

  // -----------------------------------------------------------------------
  // Module teardown (reverse order)
  // -----------------------------------------------------------------------

  private async teardownModules(): Promise<void> {
    const logger = this.modules.logger;

    // Health server
    if (this.modules.healthServer) {
      try {
        await this.modules.healthServer.stop();
        logger?.info("daemon", "Health server stopped");
      } catch (err: unknown) {
        logger?.error("daemon", "Error stopping health server", err);
      }
    }

    // SecretStore
    if (this.modules.secretStore) {
      try {
        this.modules.secretStore.close();
        logger?.info("daemon", "SecretStore closed");
      } catch (err: unknown) {
        logger?.error("daemon", "Error closing SecretStore", err);
      }
    }

    // Databases (WAL checkpoint then close)
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

    writeFileSync(pidPath, String(process.pid), "utf-8");
    this.modules.logger?.info("daemon", `PID file written: ${pidPath} (${process.pid})`);
  }

  private removePidFile(): void {
    const pidPath = getPidFilePath();
    try {
      if (existsSync(pidPath)) {
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
      this.modules.logger?.info("daemon", "Received shutdown signal");
      void this.stop().then(() => {
        process.exit(0);
      });
    };

    this.signalHandler = handler;
    process.on("SIGTERM", handler);
    process.on("SIGINT", handler);
  }

  private removeSignalHandlers(): void {
    if (!this.signalHandlerBound || !this.signalHandler) return;
    process.removeListener("SIGTERM", this.signalHandler);
    process.removeListener("SIGINT", this.signalHandler);
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
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}
