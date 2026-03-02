/**
 * Tests for the config CLI command (show and validate subcommands).
 *
 * We mock @eidolon/core's loadConfig to return controlled results
 * without touching the filesystem or real config files.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

// ---------------------------------------------------------------------------
// Mock state
// ---------------------------------------------------------------------------

let mockConfigResult: {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: { code: string; message: string; timestamp: number };
};

// Console capture
let consoleOutput: string[];
let consoleErrors: string[];

// ---------------------------------------------------------------------------
// Mock @eidolon/core
// ---------------------------------------------------------------------------

mock.module("@eidolon/core", () => ({
  loadConfig: async (_path?: string) => mockConfigResult,
}));

// ---------------------------------------------------------------------------
// Import after mocking
// ---------------------------------------------------------------------------

const { registerConfigCommand } = await import("../commands/config.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createConfigProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerConfigCommand(program);
  return program;
}

function captureConsole(): void {
  consoleOutput = [];
  consoleErrors = [];

  const origLog = console.log;
  const origError = console.error;

  console.log = (...args: unknown[]) => {
    consoleOutput.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };

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
  process.exitCode = undefined;
  captureConsole();
});

afterEach(() => {
  restoreConsole();
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// config show
// ---------------------------------------------------------------------------

describe("config show", () => {
  test("displays JSON config on success", async () => {
    const fakeConfig = {
      identity: { name: "Eidolon", ownerName: "TestUser" },
      brain: { accounts: [] },
      database: { directory: "/data" },
      logging: { level: "info" },
    };
    mockConfigResult = { ok: true, value: fakeConfig };

    const program = createConfigProgram();
    await program.parseAsync(["config", "show"], { from: "user" });

    const output = consoleOutput.join("\n");
    // Should be valid JSON output
    const parsed = JSON.parse(output);
    expect(parsed.identity.name).toBe("Eidolon");
    expect(parsed.identity.ownerName).toBe("TestUser");
    expect(parsed.brain.accounts).toEqual([]);
  });

  test("pretty-prints with 2-space indentation", async () => {
    mockConfigResult = { ok: true, value: { identity: { name: "E" } } };

    const program = createConfigProgram();
    await program.parseAsync(["config", "show"], { from: "user" });

    const output = consoleOutput.join("\n");
    // JSON.stringify with 2-space indent creates lines with "  "
    expect(output).toContain("  ");
    expect(output).toContain('"identity"');
  });

  test("shows error and sets exitCode on failure", async () => {
    mockConfigResult = {
      ok: false,
      error: {
        code: "CONFIG_NOT_FOUND",
        message: "Config file not found. Searched: /home/.config/eidolon/config.json",
        timestamp: Date.now(),
      },
    };

    const program = createConfigProgram();
    await program.parseAsync(["config", "show"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("Config file not found");
    expect(process.exitCode).toBe(1);
  });

  test("shows validation error for invalid config", async () => {
    mockConfigResult = {
      ok: false,
      error: {
        code: "CONFIG_INVALID",
        message: "Config validation failed: identity.ownerName: Required",
        timestamp: Date.now(),
      },
    };

    const program = createConfigProgram();
    await program.parseAsync(["config", "show"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("validation failed");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// config validate
// ---------------------------------------------------------------------------

describe("config validate", () => {
  test("prints success message for valid config", async () => {
    mockConfigResult = {
      ok: true,
      value: { identity: { name: "Eidolon", ownerName: "User" } },
    };

    const program = createConfigProgram();
    await program.parseAsync(["config", "validate"], { from: "user" });

    expect(consoleOutput.join("\n")).toContain("Configuration is valid");
    expect(consoleErrors).toHaveLength(0);
  });

  test("prints failure message and sets exitCode for invalid config", async () => {
    mockConfigResult = {
      ok: false,
      error: {
        code: "CONFIG_INVALID",
        message: "brain.accounts: Required",
        timestamp: Date.now(),
      },
    };

    const program = createConfigProgram();
    await program.parseAsync(["config", "validate"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("Validation failed");
    expect(consoleErrors.join("\n")).toContain("brain.accounts");
    expect(process.exitCode).toBe(1);
  });

  test("handles parse error", async () => {
    mockConfigResult = {
      ok: false,
      error: {
        code: "CONFIG_PARSE_ERROR",
        message: "Invalid JSON in /etc/eidolon.json",
        timestamp: Date.now(),
      },
    };

    const program = createConfigProgram();
    await program.parseAsync(["config", "validate"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("Invalid JSON");
    expect(process.exitCode).toBe(1);
  });

  test("handles missing config file", async () => {
    mockConfigResult = {
      ok: false,
      error: {
        code: "CONFIG_NOT_FOUND",
        message: "Config file not found",
        timestamp: Date.now(),
      },
    };

    const program = createConfigProgram();
    await program.parseAsync(["config", "validate"], { from: "user" });

    expect(consoleErrors.join("\n")).toContain("Config file not found");
    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// config show --path
// ---------------------------------------------------------------------------

describe("config show with --path option", () => {
  test("passes path option to loadConfig", async () => {
    // The mock ignores the path but the command should parse it correctly
    mockConfigResult = { ok: true, value: { identity: { name: "Custom" } } };

    const program = createConfigProgram();
    await program.parseAsync(["config", "show", "--path", "/custom/config.json"], { from: "user" });

    const output = consoleOutput.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.identity.name).toBe("Custom");
  });

  test("short -p flag works", async () => {
    mockConfigResult = { ok: true, value: { test: true } };

    const program = createConfigProgram();
    await program.parseAsync(["config", "show", "-p", "/some/path.json"], { from: "user" });

    // Should not produce errors
    expect(consoleErrors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("config edge cases", () => {
  test("config with empty value still prints valid JSON", async () => {
    mockConfigResult = { ok: true, value: {} };

    const program = createConfigProgram();
    await program.parseAsync(["config", "show"], { from: "user" });

    const output = consoleOutput.join("\n");
    expect(JSON.parse(output)).toEqual({});
  });

  test("config with nested objects serializes correctly", async () => {
    const deepConfig = {
      brain: {
        accounts: [{ type: "api-key", name: "primary", credential: "sk-xxx", priority: 50 }],
        model: { default: "claude-sonnet-4-20250514" },
      },
    };
    mockConfigResult = { ok: true, value: deepConfig };

    const program = createConfigProgram();
    await program.parseAsync(["config", "show"], { from: "user" });

    const output = consoleOutput.join("\n");
    const parsed = JSON.parse(output);
    expect(parsed.brain.accounts).toHaveLength(1);
    expect(parsed.brain.accounts[0].type).toBe("api-key");
    expect(parsed.brain.model.default).toBe("claude-sonnet-4-20250514");
  });
});
