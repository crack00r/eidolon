/**
 * PID file management, signal handlers, and utility functions for the daemon.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPidFilePath } from "../config/paths.ts";
import type { DatabaseManager } from "../database/manager.ts";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// ensureDir utility
// ---------------------------------------------------------------------------

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

// ---------------------------------------------------------------------------
// PID file management
// ---------------------------------------------------------------------------

export function writePidFile(logger: Logger | undefined): void {
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
            logger?.warn("daemon", `Stale PID file found (PID ${existingPid} not running), overwriting`);
          } else {
            throw killErr;
          }
        }
      }
    } catch (readErr: unknown) {
      // If it's the "already running" error, rethrow
      if (readErr instanceof Error && readErr.message.includes("already running")) throw readErr;
      logger?.warn("daemon", "Could not read existing PID file, overwriting", {
        error: String(readErr),
      });
    }
  }

  // FINDING-LOOP-016: Atomic write -- write to temp file, then rename
  const tmpPath = `${pidPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, String(process.pid), "utf-8");
  renameSync(tmpPath, pidPath);
  logger?.info("daemon", `PID file written: ${pidPath} (${process.pid})`);
}

// FINDING-LOOP-017: Only remove PID file if it contains our own PID
export function removePidFile(logger: Logger | undefined): void {
  const pidPath = getPidFilePath();
  try {
    if (existsSync(pidPath)) {
      const content = readFileSync(pidPath, "utf-8").trim();
      const filePid = Number.parseInt(content, 10);
      if (filePid !== process.pid) {
        logger?.warn("daemon", `PID file contains ${filePid}, not our PID ${process.pid} -- not removing`);
        return;
      }
      unlinkSync(pidPath);
      logger?.info("daemon", "PID file removed");
    }
  } catch (err: unknown) {
    logger?.warn("daemon", "Failed to remove PID file", { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Signal handlers
// ---------------------------------------------------------------------------

export interface SignalHandlerState {
  bound: boolean;
  handler?: () => void;
}

export function registerSignalHandlers(
  state: SignalHandlerState,
  logger: Logger | undefined,
  stopFn: () => Promise<void>,
  isShuttingDown: () => boolean,
): void {
  if (state.bound) return;
  state.bound = true;

  const handler = (): void => {
    // Prevent re-entrant shutdown if signal received multiple times
    if (isShuttingDown()) {
      logger?.info("daemon", "Shutdown already in progress, forcing exit on repeated signal");
      process.exit(1);
    }
    logger?.info("daemon", "Received shutdown signal");
    void stopFn()
      .then(() => {
        process.exitCode = 0;
        // Let the event loop drain naturally
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logger?.error("daemon", `Shutdown error: ${message}`, err);
        process.exitCode = 1;
      });
  };

  state.handler = handler;
  process.on("SIGTERM", handler);
  process.on("SIGINT", handler);
  process.on("SIGHUP", handler);
}

export function removeSignalHandlers(state: SignalHandlerState): void {
  if (!state.bound || !state.handler) return;
  process.removeListener("SIGTERM", state.handler);
  process.removeListener("SIGINT", state.handler);
  process.removeListener("SIGHUP", state.handler);
  state.bound = false;
  state.handler = undefined;
}

// ---------------------------------------------------------------------------
// WAL checkpoint helper
// ---------------------------------------------------------------------------

export function flushWalCheckpoints(dbManager: DatabaseManager | undefined, logger: Logger | undefined): void {
  if (!dbManager) return;
  for (const db of [dbManager.memory, dbManager.operational, dbManager.audit]) {
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      logger?.warn("daemon", "WAL checkpoint failed for one database");
    }
  }
}
