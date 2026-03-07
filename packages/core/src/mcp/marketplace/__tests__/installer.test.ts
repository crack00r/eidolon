/**
 * Tests for McpInstaller.
 *
 * Note: These tests verify the installer logic without actually running npm.
 * The install/remove methods that spawn npm are tested via integration tests.
 * Here we test the registry-interaction logic and validation.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../../logging/logger.ts";
import { McpInstaller } from "../installer.ts";
import { MarketplaceRegistry } from "../registry.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function createTempDir(): string {
  const dir = join(tmpdir(), `eidolon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempDirs.length = 0;
});

function createTestInstaller(): {
  installer: McpInstaller;
  registry: MarketplaceRegistry;
  dataDir: string;
} {
  const db = new Database(":memory:");
  const logger = createSilentLogger();
  const registry = new MarketplaceRegistry(db, logger);
  const dataDir = createTempDir();
  tempDirs.push(dataDir);
  const installer = new McpInstaller(dataDir, registry, logger);
  return { installer, registry, dataDir };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpInstaller", () => {
  test("creates install directory on construction", () => {
    const { dataDir } = createTestInstaller();
    const installDir = join(dataDir, "mcp-servers");
    expect(existsSync(installDir)).toBe(true);
  });

  test("getInstallDir returns correct path", () => {
    const { installer, dataDir } = createTestInstaller();
    expect(installer.getInstallDir()).toBe(join(dataDir, "mcp-servers"));
  });

  test("isInstalled returns false for uninstalled template", () => {
    const { installer } = createTestInstaller();
    expect(installer.isInstalled("github")).toBe(false);
  });

  test("isInstalled returns true after marking as installed in registry", () => {
    const { installer, registry } = createTestInstaller();
    registry.upsert({
      templateId: "github",
      name: "GitHub",
      packageName: "@modelcontextprotocol/server-github",
      status: "installed",
      installedAt: Date.now(),
      updatedAt: Date.now(),
      configuredInBrain: false,
    });
    expect(installer.isInstalled("github")).toBe(true);
  });

  test("isInstalled returns true for configured status", () => {
    const { installer, registry } = createTestInstaller();
    registry.upsert({
      templateId: "github",
      name: "GitHub",
      packageName: "@modelcontextprotocol/server-github",
      status: "configured",
      installedAt: Date.now(),
      updatedAt: Date.now(),
      configuredInBrain: true,
    });
    expect(installer.isInstalled("github")).toBe(true);
  });

  test("install returns error for unknown template", async () => {
    const { installer } = createTestInstaller();
    const result = await installer.install("nonexistent-template-xyz");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_NOT_FOUND");
    }
  });

  test("remove returns error for uninstalled template", async () => {
    const { installer } = createTestInstaller();
    const result = await installer.remove("github");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_NOT_FOUND");
    }
  });

  test("remove cleans up directory and registry", async () => {
    const { installer, registry, dataDir } = createTestInstaller();

    // Simulate an installed server
    const serverDir = join(dataDir, "mcp-servers", "filesystem");
    mkdirSync(serverDir, { recursive: true });

    registry.upsert({
      templateId: "filesystem",
      name: "Filesystem",
      packageName: "@modelcontextprotocol/server-filesystem",
      status: "installed",
      installPath: serverDir,
      installedAt: Date.now(),
      updatedAt: Date.now(),
      configuredInBrain: false,
    });

    const result = await installer.remove("filesystem");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.templateId).toBe("filesystem");
    expect(existsSync(serverDir)).toBe(false);
    expect(registry.get("filesystem")).toBeUndefined();
  });
});
