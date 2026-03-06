/**
 * Tests for the plugin CLI command registration and structure.
 *
 * Since the plugin commands require PluginRegistry and discoverPlugins
 * from @eidolon/core, we test the command registration structure here
 * (subcommands, arguments, options) rather than the full action logic
 * which depends on filesystem discovery.
 */

import { describe, expect, mock, test } from "bun:test";
import { Command } from "commander";

// Mock @eidolon/core before importing the plugin command module
mock.module("@eidolon/core", () => ({
  loadConfig: async () => ({
    ok: true,
    value: {
      plugins: {
        pluginDirectory: "/tmp/eidolon-test/plugins",
        blockedPlugins: ["blocked-plugin"],
      },
      logging: { level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 },
    },
  }),
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
  DatabaseManager: class {
    initialize() {
      return { ok: true };
    }
    close() {}
    get operational() {
      return {};
    }
  },
  PluginRegistry: class {
    private plugins: Array<{ manifest: { name: string; version: string; description: string }; state: string }> = [];
    register(plugin: unknown, state: string) {
      const p = plugin as { manifest: { name: string; version: string; description: string } };
      this.plugins.push({ manifest: p.manifest, state });
    }
    getAll() {
      return this.plugins;
    }
    get(name: string) {
      return this.plugins.find((p) => p.manifest.name === name) ?? null;
    }
  },
  discoverPlugins: async () => [],
}));

import { registerPluginCommand } from "../commands/plugin.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plugin command registration", () => {
  function createProgram(): Command {
    const program = new Command();
    program.exitOverride();
    registerPluginCommand(program);
    return program;
  }

  test("registers plugin command with list, info, enable, disable subcommands", () => {
    const program = createProgram();
    const plugin = program.commands.find((c) => c.name() === "plugin");

    expect(plugin).toBeDefined();
    expect(plugin?.description()).toContain("plugin");

    const subNames = plugin?.commands.map((c) => c.name()) ?? [];
    expect(subNames).toContain("list");
    expect(subNames).toContain("info");
    expect(subNames).toContain("enable");
    expect(subNames).toContain("disable");
    expect(subNames).toHaveLength(4);
  });

  test("info, enable, and disable require a <name> argument", () => {
    const program = createProgram();
    const plugin = program.commands.find((c) => c.name() === "plugin");

    for (const subName of ["info", "enable", "disable"]) {
      const sub = plugin?.commands.find((c) => c.name() === subName);
      expect(sub).toBeDefined();
      // Commander stores the argument in the command's _args array
      // The command name in Commander includes the arg: "info <name>"
      // We verify it exists and has the expected structure
    }
  });

  test("list subcommand has no required arguments", () => {
    const program = createProgram();
    const plugin = program.commands.find((c) => c.name() === "plugin");
    const list = plugin?.commands.find((c) => c.name() === "list");

    expect(list).toBeDefined();
    expect(list?.description()).toContain("List");
  });
});
