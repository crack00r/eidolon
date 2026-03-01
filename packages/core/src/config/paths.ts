/**
 * Platform-aware path resolution for Eidolon directories.
 * Uses XDG conventions on Linux, ~/Library on macOS.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG_FILENAME, DEFAULT_DATA_DIR_NAME } from "@eidolon/protocol";

/** Get the default data directory (where DBs and state go) */
export function getDataDir(): string {
  const envDir = process.env.EIDOLON_DATA_DIR;
  if (envDir) return envDir;

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", DEFAULT_DATA_DIR_NAME);
  }
  // Linux / other -- XDG
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(xdgData, DEFAULT_DATA_DIR_NAME);
}

/** Get the default config directory */
export function getConfigDir(): string {
  const envDir = process.env.EIDOLON_CONFIG_DIR;
  if (envDir) return envDir;

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Preferences", DEFAULT_DATA_DIR_NAME);
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdgConfig, DEFAULT_DATA_DIR_NAME);
}

/** Get the default log directory */
export function getLogDir(): string {
  const envDir = process.env.EIDOLON_LOG_DIR;
  if (envDir) return envDir;

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Logs", DEFAULT_DATA_DIR_NAME);
  }
  const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdgState, DEFAULT_DATA_DIR_NAME, "logs");
}

/** Get the default cache directory */
export function getCacheDir(): string {
  const envCache = process.env.EIDOLON_CACHE_DIR;
  if (envCache) return envCache;

  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches", DEFAULT_DATA_DIR_NAME);
  }
  const xdgCache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(xdgCache, DEFAULT_DATA_DIR_NAME);
}

/** Get the default config file path */
export function getConfigPath(): string {
  const envPath = process.env.EIDOLON_CONFIG;
  if (envPath) return envPath;

  return join(getConfigDir(), DEFAULT_CONFIG_FILENAME);
}

/** Get the PID file path */
export function getPidFilePath(): string {
  return join(getDataDir(), "eidolon.pid");
}
