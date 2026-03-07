/**
 * Tests for MarketplaceRegistry.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { Logger } from "../../../logging/logger.ts";
import { MarketplaceRegistry } from "../registry.ts";
import type { InstalledMcpServer } from "../types.ts";

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

function createTestRegistry(): { registry: MarketplaceRegistry; db: Database } {
  const db = new Database(":memory:");
  const logger = createSilentLogger();
  const registry = new MarketplaceRegistry(db, logger);
  return { registry, db };
}

function makeServer(overrides?: Partial<InstalledMcpServer>): InstalledMcpServer {
  return {
    templateId: "github",
    name: "GitHub",
    packageName: "@modelcontextprotocol/server-github",
    status: "installed",
    installedAt: Date.now(),
    updatedAt: Date.now(),
    configuredInBrain: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MarketplaceRegistry", () => {
  test("creates table on construction", () => {
    const { db } = createTestRegistry();
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='mcp_installed'")
      .all();
    expect(tables).toHaveLength(1);
  });

  test("upsert and get a server", () => {
    const { registry } = createTestRegistry();
    const server = makeServer();
    const result = registry.upsert(server);
    expect(result.ok).toBe(true);

    const retrieved = registry.get("github");
    expect(retrieved).toBeDefined();
    expect(retrieved?.templateId).toBe("github");
    expect(retrieved?.name).toBe("GitHub");
    expect(retrieved?.status).toBe("installed");
  });

  test("get returns undefined for unknown template", () => {
    const { registry } = createTestRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  test("upsert updates existing record", () => {
    const { registry } = createTestRegistry();
    registry.upsert(makeServer({ status: "installing" }));
    registry.upsert(makeServer({ status: "installed" }));

    const retrieved = registry.get("github");
    expect(retrieved?.status).toBe("installed");
  });

  test("listInstalled returns only non-available servers", () => {
    const { registry } = createTestRegistry();
    registry.upsert(makeServer({ templateId: "github", status: "installed" }));
    registry.upsert(makeServer({ templateId: "slack", name: "Slack", status: "available" }));
    registry.upsert(makeServer({ templateId: "notion", name: "Notion", status: "configured" }));

    const installed = registry.listInstalled();
    expect(installed).toHaveLength(2);
    const ids = installed.map((s) => s.templateId);
    expect(ids).toContain("github");
    expect(ids).toContain("notion");
  });

  test("updateStatus changes server status", () => {
    const { registry } = createTestRegistry();
    registry.upsert(makeServer());

    const result = registry.updateStatus("github", "configured");
    expect(result.ok).toBe(true);

    const retrieved = registry.get("github");
    expect(retrieved?.status).toBe("configured");
  });

  test("updateStatus sets error message on failure", () => {
    const { registry } = createTestRegistry();
    registry.upsert(makeServer());

    registry.updateStatus("github", "failed", "npm install failed");

    const retrieved = registry.get("github");
    expect(retrieved?.status).toBe("failed");
    expect(retrieved?.error).toBe("npm install failed");
  });

  test("remove deletes a server record", () => {
    const { registry } = createTestRegistry();
    registry.upsert(makeServer());

    const result = registry.remove("github");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);

    expect(registry.get("github")).toBeUndefined();
  });

  test("remove returns false for nonexistent record", () => {
    const { registry } = createTestRegistry();
    const result = registry.remove("nonexistent");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(false);
  });

  test("listAll merges templates with install status", () => {
    const { registry } = createTestRegistry();
    registry.upsert(makeServer({ templateId: "github", status: "installed" }));

    const all = registry.listAll();
    expect(all.length).toBeGreaterThan(0);

    const github = all.find((t) => t.id === "github");
    expect(github?.installStatus).toBe("installed");

    const filesystem = all.find((t) => t.id === "filesystem");
    expect(filesystem?.installStatus).toBe("available");
  });

  test("getConfigStatus identifies missing secrets", () => {
    const { registry } = createTestRegistry();
    registry.upsert(makeServer({ templateId: "github", status: "installed" }));

    const secrets = new Set<string>();
    const result = registry.getConfigStatus("github", secrets);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.isInstalled).toBe(true);
    expect(result.value.missingSecrets).toContain("GITHUB_TOKEN");
    expect(result.value.hasAllSecrets).toBe(false);
  });

  test("getConfigStatus reports all secrets present", () => {
    const { registry } = createTestRegistry();
    registry.upsert(makeServer({ templateId: "github", status: "installed" }));

    const secrets = new Set(["GITHUB_TOKEN"]);
    const result = registry.getConfigStatus("github", secrets);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hasAllSecrets).toBe(true);
    expect(result.value.missingSecrets).toHaveLength(0);
  });

  test("getConfigStatus returns error for unknown template", () => {
    const { registry } = createTestRegistry();
    const result = registry.getConfigStatus("nonexistent", new Set());
    expect(result.ok).toBe(false);
  });
});
