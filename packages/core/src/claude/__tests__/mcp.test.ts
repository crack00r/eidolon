import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrainConfig } from "@eidolon/protocol";
import { generateMcpConfig } from "../mcp.ts";

const TEST_DIR = join(import.meta.dir, ".tmp-mcp-test");

function makeBrainConfig(overrides: Partial<BrainConfig> = {}): BrainConfig {
  return {
    accounts: [{ type: "oauth", name: "test", credential: "tok", priority: 50, enabled: true }],
    model: { default: "sonnet", complex: "opus", fast: "haiku" },
    session: { maxTurns: 50, compactAfter: 40, timeoutMs: 300_000 },
    ...overrides,
  };
}

describe("generateMcpConfig", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("returns null when no MCP servers configured", async () => {
    const result = await generateMcpConfig(TEST_DIR, makeBrainConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  test("returns null when mcpServers is empty object", async () => {
    const result = await generateMcpConfig(TEST_DIR, makeBrainConfig({ mcpServers: {} }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  test("writes config file with correct structure", async () => {
    const config = makeBrainConfig({
      mcpServers: {
        filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"], env: { HOME: "/tmp" } },
        memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
      },
    });

    const result = await generateMcpConfig(TEST_DIR, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();

    const configPath = result.value as string;
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(await Bun.file(configPath).text());
    expect(written.mcpServers.filesystem.command).toBe("npx");
    expect(written.mcpServers.filesystem.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem"]);
    expect(written.mcpServers.filesystem.env).toEqual({ HOME: "/tmp" });
    expect(written.mcpServers.memory.command).toBe("npx");
  });

  test("returns file path on success", async () => {
    const config = makeBrainConfig({
      mcpServers: { test: { command: "echo" } },
    });

    const result = await generateMcpConfig(TEST_DIR, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(join(TEST_DIR, ".mcp-servers.json"));
  });
});
