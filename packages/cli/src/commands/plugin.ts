/**
 * eidolon plugin -- plugin management commands.
 */

import type { Command } from "commander";

export function registerPluginCommand(program: Command): void {
  const cmd = program.command("plugin").description("Manage Eidolon plugins");

  cmd
    .command("list")
    .description("List installed plugins")
    .action(() => {
      console.log("Not yet implemented -- connect to running daemon via gateway RPC");
    });

  cmd
    .command("info <name>")
    .description("Show details of a specific plugin")
    .action((name: string) => {
      console.log(`Not yet implemented -- plugin info for "${name}"`);
    });

  cmd
    .command("install <package>")
    .description("Install a plugin from npm")
    .action((pkg: string) => {
      console.log(`Not yet implemented -- install plugin "${pkg}"`);
    });

  cmd
    .command("uninstall <name>")
    .description("Uninstall a plugin")
    .action((name: string) => {
      console.log(`Not yet implemented -- uninstall plugin "${name}"`);
    });

  cmd
    .command("enable <name>")
    .description("Enable a disabled plugin")
    .action((name: string) => {
      console.log(`Not yet implemented -- enable plugin "${name}"`);
    });

  cmd
    .command("disable <name>")
    .description("Disable a plugin without uninstalling")
    .action((name: string) => {
      console.log(`Not yet implemented -- disable plugin "${name}"`);
    });
}
