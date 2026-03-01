import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestConfig } from "@eidolon/test-utils";
import { loadConfig } from "../loader.js";

describe("loadConfig", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "eidolon-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("loads valid config from file", async () => {
    const _config = createTestConfig();
    // Get raw config data that Zod would parse (before defaults)
    const raw = {
      identity: { name: "TestEidolon", ownerName: "TestUser" },
      brain: {
        accounts: [{ type: "api-key", name: "test", credential: "sk-test-000", priority: 50, enabled: true }],
        model: {},
        session: {},
      },
      loop: { energyBudget: { categories: {} }, rest: {}, businessHours: {} },
      memory: { extraction: {}, dreaming: {}, search: {}, embedding: {}, retention: {}, entityResolution: {} },
      learning: { relevance: {}, autoImplement: {}, budget: {} },
      channels: {},
      gateway: { auth: {} },
      gpu: { tts: {}, stt: {}, fallback: {} },
      security: { policies: {}, approval: {}, sandbox: {}, audit: {} },
      database: {},
      logging: {},
      daemon: {},
    };

    const filePath = join(tempDir, "eidolon.json");
    await Bun.write(filePath, JSON.stringify(raw));

    const result = await loadConfig(filePath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.identity.ownerName).toBe("TestUser");
      // Defaults should be resolved
      expect(result.value.database.directory).toBeTruthy();
      expect(result.value.logging.directory).toBeTruthy();
    }
  });

  test("returns CONFIG_NOT_FOUND for missing file", async () => {
    const result = await loadConfig(join(tempDir, "nonexistent.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_NOT_FOUND");
    }
  });

  test("returns CONFIG_PARSE_ERROR for invalid JSON", async () => {
    const filePath = join(tempDir, "bad.json");
    await Bun.write(filePath, "{ not valid json }");

    const result = await loadConfig(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_PARSE_ERROR");
    }
  });

  test("returns CONFIG_INVALID for invalid schema", async () => {
    const filePath = join(tempDir, "invalid.json");
    // Missing required identity.ownerName and brain.accounts
    await Bun.write(filePath, JSON.stringify({ identity: { name: "Test" } }));

    const result = await loadConfig(filePath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_INVALID");
      expect(result.error.message).toContain("validation failed");
    }
  });
});
