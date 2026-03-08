/**
 * Platform-aware path resolution for Eidolon directories.
 *
 * - **macOS**: ~/Library/{Application Support,Preferences,Logs,Caches}/eidolon
 * - **Windows**: %APPDATA%\eidolon (data, config, logs, cache all under one root)
 * - **Linux / other**: XDG conventions (~/.local/share, ~/.config, ~/.local/state, ~/.cache)
 *
 * All returned paths are canonicalized via `path.resolve()` to prevent
 * directory traversal and ensure consistent absolute paths.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG_FILENAME, DEFAULT_DATA_DIR_NAME } from "@eidolon/protocol";

/**
 * Canonicalize a path: resolves `.`, `..`, and relative segments to an absolute path.
 * This prevents directory traversal attacks via environment variables or config values.
 */
function canonicalize(p: string): string {
  return resolve(p);
}

/**
 * Get the Windows APPDATA directory. Falls back to %USERPROFILE%\AppData\Roaming
 * if APPDATA is not set (should never happen on a real Windows system).
 */
function getWindowsAppData(): string {
  return process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
}

/** Get the default data directory (where DBs and state go) */
export function getDataDir(): string {
  const envDir = process.env.EIDOLON_DATA_DIR;
  if (envDir) return canonicalize(envDir);

  if (process.platform === "darwin") {
    return canonicalize(join(homedir(), "Library", "Application Support", DEFAULT_DATA_DIR_NAME));
  }
  if (process.platform === "win32") {
    return canonicalize(join(getWindowsAppData(), DEFAULT_DATA_DIR_NAME));
  }
  // Linux / other -- XDG
  const xdgData = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return canonicalize(join(xdgData, DEFAULT_DATA_DIR_NAME));
}

/** Get the default config directory */
export function getConfigDir(): string {
  const envDir = process.env.EIDOLON_CONFIG_DIR;
  if (envDir) return canonicalize(envDir);

  if (process.platform === "darwin") {
    return canonicalize(join(homedir(), "Library", "Preferences", DEFAULT_DATA_DIR_NAME));
  }
  if (process.platform === "win32") {
    return canonicalize(join(getWindowsAppData(), DEFAULT_DATA_DIR_NAME, "config"));
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return canonicalize(join(xdgConfig, DEFAULT_DATA_DIR_NAME));
}

/** Get the directory for Eidolon's own Claude CLI config (separate from user's global Claude) */
export function getEidolonClaudeConfigDir(): string {
  return canonicalize(join(getConfigDir(), "claude-config"));
}

/** Get the default log directory */
export function getLogDir(): string {
  const envDir = process.env.EIDOLON_LOG_DIR;
  if (envDir) return canonicalize(envDir);

  if (process.platform === "darwin") {
    return canonicalize(join(homedir(), "Library", "Logs", DEFAULT_DATA_DIR_NAME));
  }
  if (process.platform === "win32") {
    return canonicalize(join(getWindowsAppData(), DEFAULT_DATA_DIR_NAME, "logs"));
  }
  const xdgState = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return canonicalize(join(xdgState, DEFAULT_DATA_DIR_NAME, "logs"));
}

/** Get the default cache directory */
export function getCacheDir(): string {
  const envCache = process.env.EIDOLON_CACHE_DIR;
  if (envCache) return canonicalize(envCache);

  if (process.platform === "darwin") {
    return canonicalize(join(homedir(), "Library", "Caches", DEFAULT_DATA_DIR_NAME));
  }
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return canonicalize(join(localAppData, DEFAULT_DATA_DIR_NAME, "cache"));
  }
  const xdgCache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return canonicalize(join(xdgCache, DEFAULT_DATA_DIR_NAME));
}

/** Get the default config file path */
export function getConfigPath(): string {
  const envPath = process.env.EIDOLON_CONFIG;
  if (envPath) return canonicalize(envPath);

  return canonicalize(join(getConfigDir(), DEFAULT_CONFIG_FILENAME));
}

/** Get the PID file path */
export function getPidFilePath(): string {
  return canonicalize(join(getDataDir(), "eidolon.pid"));
}
