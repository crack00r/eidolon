import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCacheDir, getConfigDir, getConfigPath, getDataDir, getLogDir, getPidFilePath } from "../paths.ts";

describe("paths", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save and clear relevant env vars
    for (const key of [
      "EIDOLON_DATA_DIR",
      "EIDOLON_CONFIG_DIR",
      "EIDOLON_LOG_DIR",
      "EIDOLON_CACHE_DIR",
      "EIDOLON_CONFIG",
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  // Note: platform-conditional tests verify the current OS.
  // Windows (win32) paths use %APPDATA%, macOS uses ~/Library, Linux uses XDG.
  // The win32 branch is only testable when running on Windows.

  test("getDataDir returns platform-appropriate path", () => {
    const result = getDataDir();
    if (process.platform === "darwin") {
      expect(result).toBe(join(homedir(), "Library", "Application Support", "eidolon"));
    } else if (process.platform === "win32") {
      // On Windows: %APPDATA%\eidolon
      expect(result).toContain("eidolon");
    } else {
      expect(result).toBe(join(homedir(), ".local", "share", "eidolon"));
    }
  });

  test("getDataDir respects EIDOLON_DATA_DIR env", () => {
    process.env.EIDOLON_DATA_DIR = "/custom/data";
    expect(getDataDir()).toBe("/custom/data");
  });

  test("getConfigDir returns platform-appropriate path", () => {
    const result = getConfigDir();
    if (process.platform === "darwin") {
      expect(result).toBe(join(homedir(), "Library", "Preferences", "eidolon"));
    } else if (process.platform === "win32") {
      expect(result).toContain("eidolon");
    } else {
      expect(result).toBe(join(homedir(), ".config", "eidolon"));
    }
  });

  test("getLogDir returns platform-appropriate path", () => {
    const result = getLogDir();
    if (process.platform === "darwin") {
      expect(result).toBe(join(homedir(), "Library", "Logs", "eidolon"));
    } else if (process.platform === "win32") {
      expect(result).toContain("eidolon");
      expect(result).toContain("logs");
    } else {
      expect(result).toBe(join(homedir(), ".local", "state", "eidolon", "logs"));
    }
  });

  test("getCacheDir returns platform-appropriate path", () => {
    const result = getCacheDir();
    if (process.platform === "darwin") {
      expect(result).toBe(join(homedir(), "Library", "Caches", "eidolon"));
    } else if (process.platform === "win32") {
      expect(result).toContain("eidolon");
      expect(result).toContain("cache");
    } else {
      expect(result).toBe(join(homedir(), ".cache", "eidolon"));
    }
  });

  test("getConfigDir respects EIDOLON_CONFIG_DIR env", () => {
    process.env.EIDOLON_CONFIG_DIR = "/custom/config";
    expect(getConfigDir()).toBe("/custom/config");
  });

  test("getLogDir respects EIDOLON_LOG_DIR env", () => {
    process.env.EIDOLON_LOG_DIR = "/custom/logs";
    expect(getLogDir()).toBe("/custom/logs");
  });

  test("getCacheDir respects EIDOLON_CACHE_DIR env", () => {
    process.env.EIDOLON_CACHE_DIR = "/custom/cache";
    expect(getCacheDir()).toBe("/custom/cache");
  });

  test("getConfigPath respects EIDOLON_CONFIG env", () => {
    process.env.EIDOLON_CONFIG = "/custom/eidolon.json";
    expect(getConfigPath()).toBe("/custom/eidolon.json");
  });

  test("getPidFilePath is inside data dir", () => {
    const pid = getPidFilePath();
    expect(pid).toBe(join(getDataDir(), "eidolon.pid"));
  });
});
