/**
 * eidolon config show|validate -- configuration management.
 * Fully implemented in Phase 0.
 */

import { loadConfig } from "@eidolon/core";
import type { Command } from "commander";

interface ConfigOptions {
  readonly path?: string;
}

export function registerConfigCommand(program: Command): void {
  const cmd = program.command("config").description("Configuration management");

  cmd
    .command("show")
    .description("Display resolved configuration")
    .option("-p, --path <path>", "Config file path")
    .action(async (options: ConfigOptions) => {
      const result = await loadConfig(options.path);
      if (!result.ok) {
        console.error(`Error: ${result.error.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify(result.value, null, 2));
    });

  cmd
    .command("validate")
    .description("Validate configuration file")
    .option("-p, --path <path>", "Config file path")
    .action(async (options: ConfigOptions) => {
      const result = await loadConfig(options.path);
      if (!result.ok) {
        console.error(`Validation failed: ${result.error.message}`);
        process.exitCode = 1;
        return;
      }
      console.log("Configuration is valid.");
    });
}
