import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClientConfig, buildServerConfig, writeConfig } from "../setup-finalize.ts";

describe("buildServerConfig", () => {
  test("produces config with role server", () => {
    const config = buildServerConfig({
      ownerName: "TestUser",
      claudeCredential: { type: "api_key", name: "primary", credential: "sk-test" },
      gateway: { port: 8080 },
      dataDir: "/tmp/eidolon-data",
    });

    expect(config.role).toBe("server");

    const identity = config.identity as Record<string, unknown>;
    expect(identity.ownerName).toBe("TestUser");

    const database = config.database as Record<string, unknown>;
    expect(database.directory).toBe("/tmp/eidolon-data");
  });

  test("includes all required top-level sections", () => {
    const config = buildServerConfig({
      ownerName: "Test",
      claudeCredential: { type: "api_key", name: "primary", credential: "sk-test" },
      gateway: {},
      dataDir: "/tmp",
    });

    const requiredKeys = [
      "role",
      "identity",
      "brain",
      "loop",
      "memory",
      "learning",
      "channels",
      "gateway",
      "gpu",
      "security",
      "database",
      "logging",
      "daemon",
    ];
    for (const key of requiredKeys) {
      expect(config).toHaveProperty(key);
    }
  });
});

describe("buildClientConfig", () => {
  test("produces config with role client", () => {
    const config = buildClientConfig({ host: "100.64.0.1", port: 8080, token: "abc" });

    expect(config.role).toBe("client");

    const server = config.server as Record<string, unknown>;
    expect(server.host).toBe("100.64.0.1");
    expect(server.port).toBe(8080);
    expect(server.token).toBe("abc");
    expect(server.tls).toBe(false);
  });

  test("defaults tls to false when not provided", () => {
    const config = buildClientConfig({ host: "localhost", port: 3000 });

    const server = config.server as Record<string, unknown>;
    expect(server.tls).toBe(false);
  });
});

describe("writeConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "eidolon-config-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("writes config file to disk as JSON", () => {
    const configPath = join(tempDir, "config.json");
    const config = { role: "server", test: true };

    const result = writeConfig(configPath, config);
    expect(result.ok).toBe(true);

    expect(existsSync(configPath)).toBe(true);
    const content = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    expect(content.role).toBe("server");
    expect(content.test).toBe(true);
  });

  test("creates parent directories if needed", () => {
    const configPath = join(tempDir, "nested", "deep", "config.json");
    const result = writeConfig(configPath, { role: "client" });
    expect(result.ok).toBe(true);
    expect(existsSync(configPath)).toBe(true);
  });
});
