import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunCheck } from "../checks/bun.ts";
import { createClaudeCheck } from "../checks/claude.ts";
import { createConfigCheck } from "../checks/config.ts";
import { createDiskCheck } from "../checks/disk.ts";

// ---------------------------------------------------------------------------
// Bun check
// ---------------------------------------------------------------------------

describe("createBunCheck", () => {
  test("passes when running in Bun >= 1.0", async () => {
    const check = createBunCheck();
    const result = await check();
    expect(result.name).toBe("bun");
    expect(result.status).toBe("pass");
    expect(result.message).toContain("Bun v");
  });
});

// ---------------------------------------------------------------------------
// Disk check
// ---------------------------------------------------------------------------

describe("createDiskCheck", () => {
  test("passes for a directory with plenty of free space", async () => {
    const check = createDiskCheck(tmpdir());
    const result = await check();
    expect(result.name).toBe("disk");
    // tmpdir should have plenty of space on any CI/dev machine
    expect(["pass", "warn"]).toContain(result.status);
    expect(result.message).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Config check
// ---------------------------------------------------------------------------

describe("createConfigCheck", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("passes for valid JSON config", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "eidolon-cfg-test-"));
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ identity: { name: "Test" } }));

    const check = createConfigCheck(configPath);
    const result = await check();
    expect(result.name).toBe("config");
    expect(result.status).toBe("pass");
    expect(result.message).toBe("Config file valid");
  });

  test("warns for missing config file", async () => {
    const check = createConfigCheck("/nonexistent/path/config.json");
    const result = await check();
    expect(result.name).toBe("config");
    expect(result.status).toBe("warn");
    expect(result.message).toContain("not found");
  });

  test("fails for invalid JSON", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "eidolon-cfg-test-"));
    const configPath = join(tempDir, "bad.json");
    writeFileSync(configPath, "{ invalid json content");

    const check = createConfigCheck(configPath);
    const result = await check();
    expect(result.name).toBe("config");
    expect(result.status).toBe("fail");
    expect(result.message).toContain("Invalid config");
  });
});

// ---------------------------------------------------------------------------
// Claude check
// ---------------------------------------------------------------------------

describe("createClaudeCheck", () => {
  test("returns pass or warn depending on environment", async () => {
    const check = createClaudeCheck();
    const result = await check();
    expect(result.name).toBe("claude");
    // Claude CLI may or may not be installed in the test environment
    expect(["pass", "warn"]).toContain(result.status);
  });
});
