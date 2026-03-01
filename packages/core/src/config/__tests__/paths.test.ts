import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCacheDir, getConfigDir, getConfigPath, getDataDir, getLogDir, getPidFilePath } from "../paths.js";

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

  test("getDataDir returns platform-appropriate path", () => {
    const result = getDataDir();
    if (process.platform === "darwin") {
      expect(result).toBe(join(homedir(), "Library", "Application Support", "eidolon"));
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
    } else {
      expect(result).toBe(join(homedir(), ".config", "eidolon"));
    }
  });

  test("getLogDir returns platform-appropriate path", () => {
    const result = getLogDir();
    if (process.platform === "darwin") {
      expect(result).toBe(join(homedir(), "Library", "Logs", "eidolon"));
    } else {
      expect(result).toBe(join(homedir(), ".local", "state", "eidolon", "logs"));
    }
  });

  test("getCacheDir returns platform-appropriate path", () => {
    const result = getCacheDir();
    if (process.platform === "darwin") {
      expect(result).toBe(join(homedir(), "Library", "Caches", "eidolon"));
    } else {
      expect(result).toBe(join(homedir(), ".cache", "eidolon"));
    }
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
