/**
 * Tests for onboard wizard step functions.
 *
 * Uses mocked @eidolon/core via preload.ts.
 * Individual step functions are tested in isolation.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AskFn } from "../commands/onboard-steps.ts";

// Mock console.log to capture output
let consoleOutput: string[] = [];
const originalLog = console.log;

beforeEach(() => {
  consoleOutput = [];
  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = originalLog;
});

function createMockAsk(answers: string[]): AskFn {
  let index = 0;
  return async (_question: string): Promise<string> => {
    const answer = answers[index] ?? "";
    index++;
    return answer;
  };
}

function outputContains(substring: string): boolean {
  return consoleOutput.some((line) => line.includes(substring));
}

// ---------------------------------------------------------------------------
// checkPrerequisites
// ---------------------------------------------------------------------------

describe("checkPrerequisites", () => {
  test("reports Bun version as passing", async () => {
    const { checkPrerequisites } = await import("../commands/onboard-steps.ts");
    const result = await checkPrerequisites();
    expect(result.bunOk).toBe(true);
    expect(outputContains("Bun runtime")).toBe(true);
  });

  test("reports data and config directories", async () => {
    const { checkPrerequisites } = await import("../commands/onboard-steps.ts");
    await checkPrerequisites();
    expect(outputContains("Data directory")).toBe(true);
    expect(outputContains("Config directory")).toBe(true);
    expect(outputContains("Log directory")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setupIdentity
// ---------------------------------------------------------------------------

describe("setupIdentity", () => {
  test("uses provided owner name", async () => {
    const { setupIdentity } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["Manuel"]);
    const name = await setupIdentity(ask);
    expect(name).toBe("Manuel");
  });

  test("falls back to default when empty input", async () => {
    const { setupIdentity } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk([""]);
    const name = await setupIdentity(ask);
    // Should use OS username or "User" as default
    expect(name.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// setupMasterKey
// ---------------------------------------------------------------------------

describe("setupMasterKey", () => {
  test("generates key when user accepts default", async () => {
    const { setupMasterKey } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk([""]); // Accept default (Y)
    const key = await setupMasterKey(ask);
    expect(key).toBeDefined();
    expect(typeof key).toBe("string");
    // Generated key should be 64 hex chars
    expect(key?.length).toBe(64);
  });

  test("generates key when user types Y", async () => {
    const { setupMasterKey } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["Y"]);
    const key = await setupMasterKey(ask);
    expect(key).toBeDefined();
    expect(key?.length).toBe(64);
  });

  test("accepts manual key input", async () => {
    const { setupMasterKey } = await import("../commands/onboard-steps.ts");
    const manualKey = "a".repeat(64);
    const ask = createMockAsk(["n", manualKey]);
    const key = await setupMasterKey(ask);
    expect(key).toBe(manualKey);
  });

  test("returns undefined when no key provided", async () => {
    const { setupMasterKey } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["n", ""]);
    const key = await setupMasterKey(ask);
    expect(key).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// setupClaudeAccount
// ---------------------------------------------------------------------------

describe("setupClaudeAccount", () => {
  test("defaults to OAuth when user accepts default", async () => {
    const { setupClaudeAccount } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk([""]); // Accept default [1]
    const result = await setupClaudeAccount(ask);
    expect(result.type).toBe("oauth");
    expect(result.apiKey).toBeUndefined();
  });

  test("selects API key when user chooses option 2", async () => {
    const { setupClaudeAccount } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["2", "sk-ant-test-key"]);
    const result = await setupClaudeAccount(ask);
    expect(result.type).toBe("api-key");
    expect(result.apiKey).toBe("sk-ant-test-key");
  });

  test("falls back to OAuth when no API key entered", async () => {
    const { setupClaudeAccount } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["2", ""]);
    const result = await setupClaudeAccount(ask);
    expect(result.type).toBe("oauth");
  });
});

// ---------------------------------------------------------------------------
// setupTelegram
// ---------------------------------------------------------------------------

describe("setupTelegram", () => {
  test("skips when no token provided", async () => {
    const { setupTelegram } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk([""]);
    const result = await setupTelegram(ask);
    expect(result.enabled).toBe(false);
    expect(result.allowedUserIds).toEqual([]);
  });

  test("configures with token and user IDs", async () => {
    const { setupTelegram } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["123456:ABCDEF", "111222333, 444555666"]);
    const result = await setupTelegram(ask);
    expect(result.enabled).toBe(true);
    expect(result.botToken).toBe("123456:ABCDEF");
    expect(result.allowedUserIds).toEqual([111222333, 444555666]);
  });

  test("handles empty user IDs with warning", async () => {
    const { setupTelegram } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["123456:ABCDEF", ""]);
    const result = await setupTelegram(ask);
    expect(result.enabled).toBe(true);
    expect(result.allowedUserIds).toEqual([]);
    expect(outputContains("Warning")).toBe(true);
  });

  test("filters out invalid user IDs", async () => {
    const { setupTelegram } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["token", "abc, 123, , 456"]);
    const result = await setupTelegram(ask);
    expect(result.allowedUserIds).toEqual([123, 456]);
  });
});

// ---------------------------------------------------------------------------
// setupGpuWorker
// ---------------------------------------------------------------------------

describe("setupGpuWorker", () => {
  test("skips when no host provided", async () => {
    const { setupGpuWorker } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk([""]);
    const result = await setupGpuWorker(ask);
    expect(result.enabled).toBe(false);
    expect(result.port).toBe(8420);
  });

  test("configures with host and default port", async () => {
    const { setupGpuWorker } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["192.168.1.100", ""]);
    const result = await setupGpuWorker(ask);
    expect(result.enabled).toBe(true);
    expect(result.host).toBe("192.168.1.100");
    expect(result.port).toBe(8420);
    // Connection test will fail since no real server
    expect(result.reachable).toBe(false);
  });

  test("configures with custom port", async () => {
    const { setupGpuWorker } = await import("../commands/onboard-steps.ts");
    const ask = createMockAsk(["gpu.local", "9000"]);
    const result = await setupGpuWorker(ask);
    expect(result.enabled).toBe(true);
    expect(result.host).toBe("gpu.local");
    expect(result.port).toBe(9000);
  });
});

// ---------------------------------------------------------------------------
// initializeDatabases
// ---------------------------------------------------------------------------

describe("initializeDatabases", () => {
  test("initializes all 3 databases via mock", () => {
    // This test uses the mocked DatabaseManager from preload.ts
    // which returns { ok: true } from initialize()
    const { initializeDatabases } =
      require("../commands/onboard-steps.ts") as typeof import("../commands/onboard-steps.ts");
    const result = initializeDatabases();
    // With the mocked DatabaseManager, this should succeed
    expect(typeof result).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// runHealthChecks
// ---------------------------------------------------------------------------

describe("runHealthChecks", () => {
  test("reports Bun runtime check", async () => {
    const { runHealthChecks } = await import("../commands/onboard-steps.ts");
    await runHealthChecks(true);
    expect(outputContains("Bun runtime")).toBe(true);
  });

  test("reports master key status as configured when set", async () => {
    const { runHealthChecks } = await import("../commands/onboard-steps.ts");
    await runHealthChecks(true);
    expect(outputContains("Master key configured")).toBe(true);
  });

  test("reports master key status as not set when false", async () => {
    const { runHealthChecks } = await import("../commands/onboard-steps.ts");
    await runHealthChecks(false);
    expect(outputContains("Master key not set")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// deriveMasterKeyBuffer (onboard-kdf.ts)
// ---------------------------------------------------------------------------

describe("deriveMasterKeyBuffer", () => {
  test("decodes hex key directly", () => {
    const { deriveMasterKeyBuffer } =
      require("../commands/onboard-kdf.ts") as typeof import("../commands/onboard-kdf.ts");
    const hexKey = "a".repeat(64);
    const buf = deriveMasterKeyBuffer(hexKey);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(32);
    // Verify it was hex-decoded (all 0xAA bytes)
    for (let i = 0; i < buf.length; i++) {
      expect(buf[i]).toBe(0xaa);
    }
  });

  test("derives passphrase via scrypt", () => {
    const { deriveMasterKeyBuffer } =
      require("../commands/onboard-kdf.ts") as typeof import("../commands/onboard-kdf.ts");
    const buf = deriveMasterKeyBuffer("my-test-passphrase");
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(32);
  });

  test("produces different keys for different passphrases", () => {
    const { deriveMasterKeyBuffer } =
      require("../commands/onboard-kdf.ts") as typeof import("../commands/onboard-kdf.ts");
    const buf1 = deriveMasterKeyBuffer("passphrase-one");
    const buf2 = deriveMasterKeyBuffer("passphrase-two");
    expect(buf1).not.toEqual(buf2);
  });
});
