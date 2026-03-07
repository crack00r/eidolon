/**
 * Tests for McpConfigurator.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import type { Logger } from "../../../logging/logger.ts";
import { McpConfigurator } from "../configurator.ts";
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

function createTestConfigurator(): {
  configurator: McpConfigurator;
  registry: MarketplaceRegistry;
} {
  const db = new Database(":memory:");
  const logger = createSilentLogger();
  const registry = new MarketplaceRegistry(db, logger);
  const configurator = new McpConfigurator(registry, logger);
  return { configurator, registry };
}

function createTempConfig(content: Record<string, unknown>): string {
  const dir = join(tmpdir(), `eidolon-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "eidolon.json");
  writeFileSync(configPath, JSON.stringify(content, null, 2), "utf-8");
  return configPath;
}

const tempPaths: string[] = [];

afterEach(() => {
  for (const p of tempPaths) {
    try {
      const { rmSync } = require("node:fs");
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempPaths.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("McpConfigurator", () => {
  describe("generateEntry", () => {
    test("generates entry for known template", () => {
      const { configurator } = createTestConfigurator();
      const result = configurator.generateEntry("github", new Set());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.entry.command).toBe("npx");
      expect(result.value.entry.env?.GITHUB_TOKEN).toBe("$secret:GITHUB_TOKEN");
    });

    test("reports missing secrets", () => {
      const { configurator } = createTestConfigurator();
      const result = configurator.generateEntry("github", new Set());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.missingSecrets).toContain("GITHUB_TOKEN");
    });

    test("reports no missing secrets when all present", () => {
      const { configurator } = createTestConfigurator();
      const result = configurator.generateEntry("github", new Set(["GITHUB_TOKEN"]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.missingSecrets).toHaveLength(0);
    });

    test("returns error for unknown template", () => {
      const { configurator } = createTestConfigurator();
      const result = configurator.generateEntry("nonexistent", new Set());
      expect(result.ok).toBe(false);
    });

    test("handles template without env", () => {
      const { configurator } = createTestConfigurator();
      const result = configurator.generateEntry("filesystem", new Set());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.entry.env).toBeUndefined();
      expect(result.value.missingSecrets).toHaveLength(0);
    });
  });

  describe("applyToConfig", () => {
    test("adds server to config file", () => {
      const { configurator } = createTestConfigurator();
      const configPath = createTempConfig({ brain: {} });
      tempPaths.push(configPath);

      const result = configurator.applyToConfig(configPath, "github", new Set(["GITHUB_TOKEN"]));
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.serverName).toBe("github");
      expect(result.value.applied).toBe(true);
      expect(result.value.missingSecrets).toHaveLength(0);

      // Verify file was written
      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, Record<string, Record<string, unknown>>>;
      expect(config.brain?.mcpServers?.github).toBeDefined();
    });

    test("uses custom server name", () => {
      const { configurator } = createTestConfigurator();
      const configPath = createTempConfig({ brain: {} });
      tempPaths.push(configPath);

      const result = configurator.applyToConfig(configPath, "github", new Set(), "my-github");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.serverName).toBe("my-github");
    });

    test("reports missing secrets", () => {
      const { configurator } = createTestConfigurator();
      const configPath = createTempConfig({ brain: {} });
      tempPaths.push(configPath);

      const result = configurator.applyToConfig(configPath, "github", new Set());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.missingSecrets).toContain("GITHUB_TOKEN");
    });

    test("rejects duplicate server name", () => {
      const { configurator } = createTestConfigurator();
      const configPath = createTempConfig({
        brain: { mcpServers: { github: { command: "npx" } } },
      });
      tempPaths.push(configPath);

      const result = configurator.applyToConfig(configPath, "github", new Set());
      expect(result.ok).toBe(false);
    });

    test("returns error for unknown template", () => {
      const { configurator } = createTestConfigurator();
      const configPath = createTempConfig({ brain: {} });
      tempPaths.push(configPath);

      const result = configurator.applyToConfig(configPath, "nonexistent", new Set());
      expect(result.ok).toBe(false);
    });
  });

  describe("removeFromConfig", () => {
    test("removes server from config", () => {
      const { configurator } = createTestConfigurator();
      const configPath = createTempConfig({
        brain: { mcpServers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } } },
      });
      tempPaths.push(configPath);

      const result = configurator.removeFromConfig(configPath, "github");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(true);

      const raw = readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw) as Record<string, Record<string, Record<string, unknown>>>;
      expect(config.brain?.mcpServers?.github).toBeUndefined();
    });

    test("returns false for nonexistent server", () => {
      const { configurator } = createTestConfigurator();
      const configPath = createTempConfig({ brain: { mcpServers: {} } });
      tempPaths.push(configPath);

      const result = configurator.removeFromConfig(configPath, "nonexistent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(false);
    });
  });

  describe("getStatuses", () => {
    test("returns statuses for installed servers", () => {
      const { configurator, registry } = createTestConfigurator();
      registry.upsert({
        templateId: "github",
        name: "GitHub",
        packageName: "@modelcontextprotocol/server-github",
        status: "installed",
        installedAt: Date.now(),
        updatedAt: Date.now(),
        configuredInBrain: true,
      });

      const statuses = configurator.getStatuses(new Set(["GITHUB_TOKEN"]));
      expect(statuses).toHaveLength(1);
      expect(statuses[0]?.templateId).toBe("github");
      expect(statuses[0]?.hasAllSecrets).toBe(true);
      expect(statuses[0]?.isConfigured).toBe(true);
    });
  });
});
