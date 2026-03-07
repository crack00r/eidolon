/**
 * eidolon mcp marketplace commands -- install, remove, and discover MCP servers.
 *
 * Subcommands:
 *   install  <template-id> -- install an MCP server package via npm
 *   remove   <template-id> -- remove an installed MCP server
 *   discover <query>       -- find MCP servers matching a natural language query
 *   installed              -- list installed MCP servers with their status
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  getConfigPath,
  getDataDir,
  MarketplaceRegistry,
  McpConfigurator,
  McpInstaller,
  searchMcpTemplates,
} from "@eidolon/core";
import { OPERATIONAL_DB_FILENAME } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatTable } from "../utils/formatter.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCliLogger(): {
  debug(module: string, message: string): void;
  info(module: string, message: string): void;
  warn(module: string, message: string): void;
  error(module: string, message: string, error?: unknown): void;
  child(module: string): ReturnType<typeof createCliLogger>;
} {
  return {
    debug: () => {},
    info: (_mod, msg) => console.log(msg),
    warn: (_mod, msg) => console.warn(`Warning: ${msg}`),
    error: (_mod, msg) => console.error(`Error: ${msg}`),
    child: () => createCliLogger(),
  };
}

function openOperationalDb(): Database {
  const dbPath = join(getDataDir(), OPERATIONAL_DB_FILENAME);
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  return db;
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

export function registerMcpMarketplaceCommands(mcpCmd: Command): void {
  // -----------------------------------------------------------------------
  // eidolon mcp install <template-id>
  // -----------------------------------------------------------------------
  mcpCmd
    .command("install <template-id>")
    .description("Install an MCP server package (npm-based)")
    .option("--config <path>", "Path to eidolon.json (auto-configure after install)")
    .option("--name <name>", "Override the server name in config")
    .action(async (templateId: string, options: { readonly config?: string; readonly name?: string }) => {
      const logger = createCliLogger();
      const db = openOperationalDb();

      try {
        const registry = new MarketplaceRegistry(db, logger);
        const installer = new McpInstaller(getDataDir(), registry, logger);

        console.log(`Installing MCP server: ${templateId}...`);
        const installResult = await installer.install(templateId);

        if (!installResult.ok) {
          console.error(`Error: ${installResult.error.message}`);
          process.exitCode = 1;
          return;
        }

        const { packageName, version } = installResult.value;
        console.log(`Successfully installed ${packageName}@${version}`);

        // Auto-configure if config path available
        const configPath = options.config ?? getConfigPath();
        const configurator = new McpConfigurator(registry, logger);
        const configResult = configurator.applyToConfig(configPath, templateId, new Set(), options.name);

        if (configResult.ok) {
          console.log(`Added to config as "${configResult.value.serverName}"`);

          if (configResult.value.missingSecrets.length > 0) {
            console.log("");
            console.log("Required secrets (set before starting daemon):");
            for (const secret of configResult.value.missingSecrets) {
              console.log(`  eidolon secrets set ${secret} --value <your-value>`);
            }
          }
        } else {
          console.warn(`Note: Could not auto-configure: ${configResult.error.message}`);
          console.log(`Run 'eidolon mcp add ${templateId}' to add it to your config manually.`);
        }
      } finally {
        db.close();
      }
    });

  // -----------------------------------------------------------------------
  // eidolon mcp remove <template-id>
  // -----------------------------------------------------------------------
  mcpCmd
    .command("remove <template-id>")
    .description("Remove an installed MCP server")
    .option("--config <path>", "Path to eidolon.json")
    .action(async (templateId: string, options: { readonly config?: string }) => {
      const logger = createCliLogger();
      const db = openOperationalDb();

      try {
        const registry = new MarketplaceRegistry(db, logger);
        const installer = new McpInstaller(getDataDir(), registry, logger);

        // Remove from config first
        const configPath = options.config ?? getConfigPath();
        const configurator = new McpConfigurator(registry, logger);
        const configResult = configurator.removeFromConfig(configPath, templateId);

        if (configResult.ok && configResult.value) {
          console.log(`Removed "${templateId}" from config.`);
        }

        // Uninstall package
        console.log(`Removing MCP server: ${templateId}...`);
        const removeResult = await installer.remove(templateId);

        if (!removeResult.ok) {
          console.error(`Error: ${removeResult.error.message}`);
          process.exitCode = 1;
          return;
        }

        console.log(`Successfully removed ${removeResult.value.packageName}`);
      } finally {
        db.close();
      }
    });

  // -----------------------------------------------------------------------
  // eidolon mcp discover <query>
  // -----------------------------------------------------------------------
  mcpCmd
    .command("discover <query>")
    .description("Find MCP servers matching a natural language query (keyword-based)")
    .action((query: string) => {
      // Use keyword-based discovery (no LLM needed for CLI)
      const results = searchMcpTemplates(query);

      if (results.length === 0) {
        console.log(`No MCP servers found matching "${query}".`);
        console.log("Try broader terms or run 'eidolon mcp list' to see all available servers.");
        return;
      }

      const rows = results.map((t) => ({
        ID: t.id,
        Name: t.name,
        Description: t.description.slice(0, 60) + (t.description.length > 60 ? "..." : ""),
        Tags: t.tags.join(", "),
      }));

      console.log(`Found ${String(results.length)} matching MCP server(s):`);
      console.log(formatTable(rows, ["ID", "Name", "Description", "Tags"]));
      console.log("");
      console.log("Install with: eidolon mcp install <id>");
    });

  // -----------------------------------------------------------------------
  // eidolon mcp installed
  // -----------------------------------------------------------------------
  mcpCmd
    .command("installed")
    .description("List installed MCP servers and their status")
    .action(() => {
      const logger = createCliLogger();
      const db = openOperationalDb();

      try {
        const registry = new MarketplaceRegistry(db, logger);
        const installed = registry.listInstalled();

        if (installed.length === 0) {
          console.log("No MCP servers installed.");
          console.log("Run 'eidolon mcp list' to see available servers, then 'eidolon mcp install <id>'.");
          return;
        }

        const rows = installed.map((s) => ({
          ID: s.templateId,
          Name: s.name,
          Status: s.status,
          Package: s.packageName,
          Configured: s.configuredInBrain ? "Yes" : "No",
          Error: s.error ?? "",
        }));

        console.log(formatTable(rows, ["ID", "Name", "Status", "Package", "Configured", "Error"]));
      } finally {
        db.close();
      }
    });
}
