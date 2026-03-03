import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrainConfig, EidolonError, Result } from "@eidolon/protocol";
import { createError, ErrorCode, Ok } from "@eidolon/protocol";
import type { SecretResolver } from "../mcp.ts";
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

/** Test secret resolver that returns values from a map. */
function fakeResolver(secrets: Record<string, string>): SecretResolver {
  return (key: string): Result<string, EidolonError> => {
    const value = secrets[key];
    if (value === undefined) {
      return { ok: false, error: createError(ErrorCode.SECRET_NOT_FOUND, `Secret '${key}' not found`) };
    }
    return Ok(value);
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
    if (!result.value) return;

    const configPath = result.value.path;
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(await Bun.file(configPath).text()) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };
    expect(written.mcpServers.filesystem!.command).toBe("npx");
    expect(written.mcpServers.filesystem!.args).toEqual(["-y", "@modelcontextprotocol/server-filesystem"]);
    expect(written.mcpServers.filesystem!.env).toEqual({ HOME: "/tmp" });
    expect(written.mcpServers.memory!.command).toBe("npx");
  });

  test("returns file path on success", async () => {
    const config = makeBrainConfig({
      mcpServers: { test: { command: "echo" } },
    });

    const result = await generateMcpConfig(TEST_DIR, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    if (!result.value) return;
    expect(result.value.path).toBe(join(TEST_DIR, ".mcp-servers.json"));
  });

  test("resolves $secret: env values via resolver", async () => {
    const config = makeBrainConfig({
      mcpServers: {
        ha: {
          command: "npx",
          args: ["-y", "mcp-server-home-assistant"],
          env: { HA_TOKEN: "$secret:HA_TOKEN", HA_URL: "http://homeassistant.local:8123" },
        },
      },
    });

    const resolver = fakeResolver({ HA_TOKEN: "my-secret-token-123" });
    const result = await generateMcpConfig(TEST_DIR, config, resolver);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    if (!result.value) return;

    const written = JSON.parse(await Bun.file(result.value.path).text()) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    // Secret should be resolved
    expect(written.mcpServers.ha!.env?.HA_TOKEN).toBe("my-secret-token-123");
    // Non-secret env should pass through unchanged
    expect(written.mcpServers.ha!.env?.HA_URL).toBe("http://homeassistant.local:8123");
  });

  test("returns error when secret resolver fails", async () => {
    const config = makeBrainConfig({
      mcpServers: {
        ha: {
          command: "npx",
          env: { TOKEN: "$secret:MISSING_KEY" },
        },
      },
    });

    const resolver = fakeResolver({}); // empty -- key will not be found
    const result = await generateMcpConfig(TEST_DIR, config, resolver);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SECRET_NOT_FOUND");
    expect(result.error.message).toContain("MISSING_KEY");
  });

  test("cleanup function removes config file", async () => {
    const config = makeBrainConfig({
      mcpServers: { test: { command: "echo" } },
    });

    const result = await generateMcpConfig(TEST_DIR, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    if (!result.value) return;

    const configPath = result.value.path;
    expect(existsSync(configPath)).toBe(true);

    // Call cleanup
    result.value.cleanup();
    expect(existsSync(configPath)).toBe(false);
  });

  test("works without secret resolver (no resolution)", async () => {
    const config = makeBrainConfig({
      mcpServers: {
        ha: {
          command: "npx",
          env: { TOKEN: "$secret:HA_TOKEN" },
        },
      },
    });

    // No resolver passed -- $secret: values are written as-is
    const result = await generateMcpConfig(TEST_DIR, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    if (!result.value) return;

    const written = JSON.parse(await Bun.file(result.value.path).text()) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(written.mcpServers.ha!.env?.TOKEN).toBe("$secret:HA_TOKEN");
  });
});
