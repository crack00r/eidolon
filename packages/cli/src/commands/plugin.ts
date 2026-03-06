/**
 * eidolon plugin -- plugin management commands.
 *
 * Subcommands:
 *   list            -- list installed plugins with name, version, status
 *   enable <name>   -- enable a plugin
 *   disable <name>  -- disable a plugin
 *   info <name>     -- show plugin details
 */

import { createLogger, discoverPlugins, loadConfig, PluginRegistry } from "@eidolon/core";
import type { PluginInfo } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatTable } from "../utils/formatter.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatPluginState(state: string): string {
  const icons: Record<string, string> = {
    discovered: "discovered",
    loaded: "loaded",
    initialized: "initialized",
    started: "running",
    stopped: "stopped",
    error: "ERROR",
  };
  return icons[state] ?? state;
}

function formatPermissions(permissions: readonly string[]): string {
  if (permissions.length === 0) return "(none)";
  return permissions.join(", ");
}

function formatExtensionPoints(points: readonly { readonly type: string; readonly name: string }[]): string {
  if (points.length === 0) return "(none)";
  return points.map((p) => `${p.type}: ${p.name}`).join(", ");
}

/**
 * Discover plugins from the configured plugin directory and return a registry.
 * This does NOT start plugins -- it only discovers and registers them.
 */
async function discoverAndRegister(): Promise<{
  readonly registry: PluginRegistry;
  readonly pluginDir: string;
} | null> {
  const configResult = await loadConfig();
  if (!configResult.ok) {
    console.error(`Error: ${configResult.error.message}`);
    process.exitCode = 1;
    return null;
  }

  const config = configResult.value;
  const logger = createLogger(config.logging);
  const registry = new PluginRegistry(logger);
  const pluginDir = config.plugins.directory;

  // Discover plugins from disk
  const loaded = await discoverPlugins(pluginDir, logger);
  for (const plugin of loaded) {
    const blocked = config.plugins.blockedPlugins.includes(plugin.manifest.name);
    registry.register(plugin, blocked ? "stopped" : "discovered");
  }

  return { registry, pluginDir };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerPluginCommand(program: Command): void {
  const cmd = program.command("plugin").description("Manage Eidolon plugins");

  // -- list ---------------------------------------------------------------
  cmd
    .command("list")
    .description("List installed plugins")
    .action(async () => {
      const result = await discoverAndRegister();
      if (!result) return;

      const { registry, pluginDir } = result;
      const plugins = registry.getAll();

      if (plugins.length === 0) {
        console.log("No plugins found.");
        console.log(`Plugin directory: ${pluginDir}`);
        return;
      }

      const rows = plugins.map((p) => ({
        Name: p.manifest.name,
        Version: p.manifest.version,
        Status: formatPluginState(p.state),
        Description: truncate(p.manifest.description, 50),
      }));

      console.log(`Found ${plugins.length} plugin${plugins.length !== 1 ? "s" : ""}:`);
      console.log("");
      console.log(formatTable(rows, ["Name", "Version", "Status", "Description"]));
      console.log("");
      console.log(`Plugin directory: ${pluginDir}`);
    });

  // -- info <name> --------------------------------------------------------
  cmd
    .command("info <name>")
    .description("Show details of a specific plugin")
    .action(async (name: string) => {
      const result = await discoverAndRegister();
      if (!result) return;

      const { registry } = result;
      const plugin = registry.get(name);

      if (!plugin) {
        console.error(`Error: Plugin "${name}" not found.`);
        console.log("Use 'eidolon plugin list' to see available plugins.");
        process.exitCode = 1;
        return;
      }

      printPluginDetails(plugin);
    });

  // -- enable <name> ------------------------------------------------------
  cmd
    .command("enable <name>")
    .description("Enable a disabled plugin")
    .action(async (name: string) => {
      const configResult = await loadConfig();
      if (!configResult.ok) {
        console.error(`Error: ${configResult.error.message}`);
        process.exitCode = 1;
        return;
      }

      const config = configResult.value;
      const blocked = config.plugins.blockedPlugins;

      if (!blocked.includes(name)) {
        console.log(`Plugin "${name}" is not blocked. It will be loaded on next daemon start.`);
        return;
      }

      console.log(`To enable plugin "${name}", remove it from "plugins.blockedPlugins" in eidolon.json.`);
      console.log("Then restart the daemon with 'eidolon daemon stop && eidolon daemon start'.");
    });

  // -- disable <name> -----------------------------------------------------
  cmd
    .command("disable <name>")
    .description("Disable a plugin without uninstalling")
    .action(async (name: string) => {
      const configResult = await loadConfig();
      if (!configResult.ok) {
        console.error(`Error: ${configResult.error.message}`);
        process.exitCode = 1;
        return;
      }

      const config = configResult.value;
      const blocked = config.plugins.blockedPlugins;

      if (blocked.includes(name)) {
        console.log(`Plugin "${name}" is already disabled (blocked).`);
        return;
      }

      console.log(`To disable plugin "${name}", add it to "plugins.blockedPlugins" in eidolon.json:`);
      console.log("");
      console.log(`  "plugins": {`);
      console.log(`    "blockedPlugins": ["${name}"]`);
      console.log(`  }`);
      console.log("");
      console.log("Then restart the daemon with 'eidolon daemon stop && eidolon daemon start'.");
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 3)}...`;
}

function printPluginDetails(plugin: PluginInfo): void {
  const m = plugin.manifest;
  console.log(`Plugin: ${m.name}`);
  console.log(`  Version:      ${m.version}`);
  console.log(`  Description:  ${m.description}`);
  if (m.author) {
    console.log(`  Author:       ${m.author}`);
  }
  console.log(`  Eidolon min:  ${m.eidolonVersion}`);
  console.log(`  Entry point:  ${m.main}`);
  console.log(`  State:        ${formatPluginState(plugin.state)}`);
  if (plugin.error) {
    console.log(`  Error:        ${plugin.error}`);
  }
  if (plugin.loadedAt) {
    console.log(`  Loaded at:    ${new Date(plugin.loadedAt).toISOString()}`);
  }
  if (plugin.startedAt) {
    console.log(`  Started at:   ${new Date(plugin.startedAt).toISOString()}`);
  }
  console.log(`  Directory:    ${plugin.directory}`);
  console.log(`  Permissions:  ${formatPermissions(m.permissions)}`);
  console.log(`  Extensions:   ${formatExtensionPoints(m.extensionPoints)}`);
}
