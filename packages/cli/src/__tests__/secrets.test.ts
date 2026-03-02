/**
 * Tests for the secrets CLI command.
 *
 * We mock @eidolon/core's getMasterKey, getDataDir, SecretStore, and zeroBuffer
 * to avoid requiring real encryption infrastructure. The tests verify that the
 * command functions route correctly to the SecretStore and produce proper output.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state -- shared across mocked modules
// ---------------------------------------------------------------------------

let mockSecrets: Map<string, { value: string; description?: string; createdAt: number; updatedAt: number }>;
let mockMasterKeyOk: boolean;
let mockMasterKeyError: string;

// Track console output
let consoleOutput: string[];
let consoleErrors: string[];
let _savedExitCode: number | undefined;

// ---------------------------------------------------------------------------
// We mock the @eidolon/core module to avoid loading real crypto/DB
// ---------------------------------------------------------------------------

mock.module("@eidolon/core", () => ({
  getMasterKey: () => {
    if (mockMasterKeyOk) {
      return { ok: true, value: Buffer.alloc(32, 0xaa) };
    }
    return { ok: false, error: { message: mockMasterKeyError, code: "MASTER_KEY_MISSING" } };
  },
  getDataDir: () => "/tmp/eidolon-test-data",
  zeroBuffer: (_buf: Buffer) => {},
  SecretStore: class MockSecretStore {
    set(key: string, value: string, description?: string) {
      mockSecrets.set(key, {
        value,
        description,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return { ok: true } as const;
    }

    get(key: string) {
      const entry = mockSecrets.get(key);
      if (!entry) {
        return { ok: false, error: { message: `Secret '${key}' not found`, code: "SECRET_NOT_FOUND" } } as const;
      }
      return { ok: true, value: entry.value } as const;
    }

    delete(key: string) {
      if (!mockSecrets.has(key)) {
        return { ok: false, error: { message: `Secret '${key}' not found`, code: "SECRET_NOT_FOUND" } } as const;
      }
      mockSecrets.delete(key);
      return { ok: true } as const;
    }

    list() {
      const entries = Array.from(mockSecrets.entries()).map(([key, entry]) => ({
        key,
        description: entry.description,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        accessedAt: entry.updatedAt,
      }));
      return { ok: true, value: entries } as const;
    }

    close() {}
  },
}));

// We also need to mock the formatter since it's imported from a relative path
// but that should resolve fine since it's our own code. Let's keep it real.

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

const { registerSecretsCommand } = await import("../commands/secrets.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSecretsProgram(): Command {
  const program = new Command();
  program.exitOverride();
  // Suppress commander's stderr output to avoid Bun test runner exit code 1
  program.configureOutput({ writeErr: () => {} });
  registerSecretsCommand(program);
  return program;
}

function captureConsole(): void {
  consoleOutput = [];
  consoleErrors = [];
  _savedExitCode = undefined;

  const origLog = console.log;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };

  // Return cleanup in a way we can use
  (globalThis as Record<string, unknown>).__restoreConsole = () => {
    console.log = origLog;
    console.error = origError;
  };
}

function restoreConsole(): void {
  const restore = (globalThis as Record<string, unknown>).__restoreConsole as (() => void) | undefined;
  if (restore) restore();
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockSecrets = new Map();
  mockMasterKeyOk = true;
  mockMasterKeyError = "";
  process.exitCode = 0;
  captureConsole();
});

afterEach(() => {
  restoreConsole();
  // Use 0 instead of undefined — Bun does not reset exit code when set to undefined
  process.exitCode = 0;
});

// ---------------------------------------------------------------------------
// secrets set
// ---------------------------------------------------------------------------

describe("secrets set", () => {
  test("stores a secret successfully", async () => {
    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "set", "my-api-key", "--value", "sk-12345"], { from: "user" });

    expect(consoleOutput.join("\n")).toContain("stored successfully");
    expect(mockSecrets.has("my-api-key")).toBe(true);
    expect(mockSecrets.get("my-api-key")?.value).toBe("sk-12345");
  });

  test("stores a secret with description", async () => {
    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "set", "token", "--value", "abc123", "--description", "My token"], {
      from: "user",
    });

    expect(mockSecrets.get("token")?.description).toBe("My token");
  });

  test("fails when master key is not set", async () => {
    mockMasterKeyOk = false;
    mockMasterKeyError = "EIDOLON_MASTER_KEY environment variable not set";

    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "set", "key", "--value", "val"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("EIDOLON_MASTER_KEY");
    expect(process.exitCode).toBe(1);
  });

  test("requires --value option", async () => {
    const program = createSecretsProgram();
    // Suppress commander's stderr to prevent Bun test runner from picking up
    // the error output and setting a non-zero exit code
    const origWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    try {
      await program.parseAsync(["secrets", "set", "key"], { from: "user" });
      // Commander should throw due to exitOverride when required option is missing
      expect(true).toBe(false); // Should not reach
    } catch (err: unknown) {
      // Commander throws CommanderError for missing required options
      expect(err).toBeDefined();
    } finally {
      process.stderr.write = origWrite;
    }
  });
});

// ---------------------------------------------------------------------------
// secrets get
// ---------------------------------------------------------------------------

describe("secrets get", () => {
  beforeEach(() => {
    mockSecrets.set("existing-key", {
      value: "supersecretvalue",
      description: "Test secret",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  test("retrieves and masks a secret by default", async () => {
    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "get", "existing-key"], { from: "user" });

    const output = consoleOutput.join("\n");
    // Should show masked value: ****<last4>
    expect(output).toContain("****");
    expect(output).toContain("alue"); // last 4 chars of "supersecretvalue"
    expect(output).not.toContain("supersecretvalue"); // full value should NOT appear
  });

  test("reveals secret with --reveal flag", async () => {
    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "get", "existing-key", "--reveal"], { from: "user" });

    expect(consoleOutput.join("\n")).toContain("supersecretvalue");
  });

  test("masks short secrets with all asterisks", async () => {
    mockSecrets.set("short-key", {
      value: "ab",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "get", "short-key"], { from: "user" });

    expect(consoleOutput.join("\n")).toContain("********");
  });

  test("errors for nonexistent key", async () => {
    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "get", "nonexistent"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("not found");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// secrets list
// ---------------------------------------------------------------------------

describe("secrets list", () => {
  test("shows 'No secrets stored' when empty", async () => {
    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "list"], { from: "user" });

    expect(consoleOutput.join("\n")).toContain("No secrets stored");
  });

  test("lists secrets in table format", async () => {
    mockSecrets.set("api-key", {
      value: "sk-123",
      description: "API key",
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    mockSecrets.set("token", {
      value: "tok-456",
      description: "Token",
      createdAt: 1700000100000,
      updatedAt: 1700000100000,
    });

    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "list"], { from: "user" });

    const output = consoleOutput.join("\n");
    expect(output).toContain("Key");
    expect(output).toContain("Description");
    expect(output).toContain("api-key");
    expect(output).toContain("token");
    expect(output).toContain("API key");
    // Should NOT contain actual values
    expect(output).not.toContain("sk-123");
    expect(output).not.toContain("tok-456");
  });

  test("fails when master key is not set", async () => {
    mockMasterKeyOk = false;
    mockMasterKeyError = "Master key missing";

    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "list"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("Master key missing");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// secrets delete
// ---------------------------------------------------------------------------

describe("secrets delete", () => {
  beforeEach(() => {
    mockSecrets.set("to-delete", {
      value: "val",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });

  test("deletes an existing secret", async () => {
    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "delete", "to-delete"], { from: "user" });

    expect(consoleOutput.join("\n")).toContain("deleted");
    expect(mockSecrets.has("to-delete")).toBe(false);
  });

  test("errors when deleting nonexistent secret", async () => {
    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "delete", "nonexistent"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("not found");
    expect(process.exitCode).toBe(1);
  });

  test("fails when master key is not set", async () => {
    mockMasterKeyOk = false;
    mockMasterKeyError = "No master key";

    const program = createSecretsProgram();
    await program.parseAsync(["secrets", "delete", "to-delete"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("No master key");
    expect(process.exitCode).toBe(1);
    // Secret should still exist since store couldn't be opened
    expect(mockSecrets.has("to-delete")).toBe(true);
  });
});
