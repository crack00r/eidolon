/**
 * eidolon mcp -- MCP server template management and health monitoring.
 *
 * Subcommands:
 *   list    -- list available MCP server templates
 *   add     -- add an MCP server from a template to config
 *   status  -- show health of configured MCP servers
 *   search  -- search templates by keyword
 */

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createConnection,
  getConfigPath,
  getDataDir,
  getMcpTemplate,
  KGEntityStore,
  KGRelationStore,
  listMcpTemplates,
  MEMORY_MIGRATIONS,
  MemoryMcpServer,
  MemoryStore,
  runMigrations,
  searchMcpTemplates,
  templateToConfigEntry,
} from "@eidolon/core";
import { MEMORY_DB_FILENAME } from "@eidolon/protocol";
import type { Command } from "commander";
import { formatTable } from "../utils/formatter.ts";
import { registerMcpMarketplaceCommands } from "./mcp-marketplace.ts";

export function registerMcpCommand(program: Command): void {
  const cmd = program.command("mcp").description("Manage MCP server integrations");

  // -----------------------------------------------------------------------
  // eidolon mcp list
  // -----------------------------------------------------------------------
  cmd
    .command("list")
    .description("List all available MCP server templates")
    .action(() => {
      const templates = listMcpTemplates();

      if (templates.length === 0) {
        console.log("No MCP server templates available.");
        return;
      }

      const rows = templates.map((t) => ({
        ID: t.id,
        Name: t.name,
        Description: t.description,
        Secrets: t.requiredSecrets.length > 0 ? t.requiredSecrets.join(", ") : "(none)",
        Tags: t.tags.join(", "),
      }));

      console.log(formatTable(rows, ["ID", "Name", "Description", "Secrets", "Tags"]));
    });

  // -----------------------------------------------------------------------
  // eidolon mcp search <query>
  // -----------------------------------------------------------------------
  cmd
    .command("search <query>")
    .description("Search MCP server templates by name, tag, or description")
    .action((query: string) => {
      const results = searchMcpTemplates(query);

      if (results.length === 0) {
        console.log(`No templates matching "${query}".`);
        return;
      }

      const rows = results.map((t) => ({
        ID: t.id,
        Name: t.name,
        Description: t.description,
        Secrets: t.requiredSecrets.length > 0 ? t.requiredSecrets.join(", ") : "(none)",
      }));

      console.log(formatTable(rows, ["ID", "Name", "Description", "Secrets"]));
    });

  // -----------------------------------------------------------------------
  // eidolon mcp info <template-id>
  // -----------------------------------------------------------------------
  cmd
    .command("info <template-id>")
    .description("Show detailed information about an MCP server template")
    .action((templateId: string) => {
      const template = getMcpTemplate(templateId);

      if (!template) {
        console.error(`Error: Unknown template "${templateId}". Run 'eidolon mcp list' to see available templates.`);
        process.exitCode = 1;
        return;
      }

      console.log(`Template: ${template.name} (${template.id})`);
      console.log(`Description: ${template.description}`);
      console.log(`Command: ${template.command} ${template.args.join(" ")}`);

      if (template.requiredSecrets.length > 0) {
        console.log(`Required secrets: ${template.requiredSecrets.join(", ")}`);
        console.log(
          `  Set them with: ${template.requiredSecrets.map((s) => `eidolon secrets set ${s} --value <value>`).join("\n                  ")}`,
        );
      } else {
        console.log("Required secrets: (none)");
      }

      if (template.env) {
        console.log("Environment variables:");
        for (const [key, value] of Object.entries(template.env)) {
          console.log(`  ${key}=${value}`);
        }
      }

      if (template.documentationUrl) {
        console.log(`Documentation: ${template.documentationUrl}`);
      }

      console.log(`Tags: ${template.tags.join(", ")}`);
    });

  // -----------------------------------------------------------------------
  // eidolon mcp add <template-id>
  // -----------------------------------------------------------------------
  cmd
    .command("add <template-id>")
    .description("Add an MCP server to your configuration from a template")
    .option("--name <name>", "Override the server name in config")
    .option("--config <path>", "Path to eidolon.json")
    .action((templateId: string, options: { readonly name?: string; readonly config?: string }) => {
      const template = getMcpTemplate(templateId);

      if (!template) {
        console.error(`Error: Unknown template "${templateId}". Run 'eidolon mcp list' to see available templates.`);
        process.exitCode = 1;
        return;
      }

      const configPath = options.config ?? getConfigPath();

      // Read existing config
      let config: Record<string, unknown>;
      try {
        const raw = readFileSync(configPath, "utf-8");
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        console.error(`Error: Could not read config file at ${configPath}`);
        process.exitCode = 1;
        return;
      }

      // Ensure brain.mcpServers exists
      const brain = (config.brain ?? {}) as Record<string, unknown>;
      const mcpServers = (brain.mcpServers ?? {}) as Record<string, unknown>;

      const serverName = options.name ?? template.id;

      // Check if already exists
      if (serverName in mcpServers) {
        console.error(
          `Error: MCP server "${serverName}" already exists in config. Use a different --name or remove the existing entry first.`,
        );
        process.exitCode = 1;
        return;
      }

      // Add the template entry
      const entry = templateToConfigEntry(template);
      mcpServers[serverName] = entry;
      brain.mcpServers = mcpServers;
      config.brain = brain;

      // Write back
      try {
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
      } catch {
        console.error(`Error: Could not write config file at ${configPath}`);
        process.exitCode = 1;
        return;
      }

      console.log(`MCP server "${serverName}" added to ${configPath}`);

      if (template.requiredSecrets.length > 0) {
        console.log("");
        console.log("Required secrets (set these before starting the daemon):");
        for (const secret of template.requiredSecrets) {
          console.log(`  eidolon secrets set ${secret} --value <your-value>`);
        }
      }

      // Update env values if they reference secrets
      if (template.env) {
        const secretRefs = Object.entries(template.env).filter(([, v]) => v.startsWith("$secret:"));
        if (secretRefs.length > 0) {
          console.log("");
          console.log("Note: Environment variables referencing secrets will be resolved at runtime.");
        }
      }
    });

  // -----------------------------------------------------------------------
  // eidolon mcp status
  // -----------------------------------------------------------------------
  cmd
    .command("status")
    .description("Show health status of configured MCP servers")
    .option("--config <path>", "Path to eidolon.json")
    .action((options: { readonly config?: string }) => {
      const configPath = options.config ?? getConfigPath();

      let config: Record<string, unknown>;
      try {
        const raw = readFileSync(configPath, "utf-8");
        config = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        console.error(`Error: Could not read config file at ${configPath}`);
        process.exitCode = 1;
        return;
      }

      const brain = (config.brain ?? {}) as Record<string, unknown>;
      const mcpServers = (brain.mcpServers ?? {}) as Record<string, Record<string, unknown>>;

      const serverNames = Object.keys(mcpServers);

      if (serverNames.length === 0) {
        console.log("No MCP servers configured.");
        console.log("Run 'eidolon mcp list' to see available templates, then 'eidolon mcp add <id>' to add one.");
        return;
      }

      const rows = serverNames.map((name) => {
        const server = mcpServers[name];
        const command = String(server?.command ?? "");
        const args = Array.isArray(server?.args) ? (server.args as string[]).join(" ") : "";
        return {
          Name: name,
          Command: `${command} ${args}`.trim(),
          Status: "(run 'eidolon daemon start' for live health monitoring)",
        };
      });

      console.log("Configured MCP servers:");
      console.log(formatTable(rows, ["Name", "Command", "Status"]));
    });

  // -----------------------------------------------------------------------
  // Marketplace commands (install, remove, discover, installed)
  // -----------------------------------------------------------------------
  registerMcpMarketplaceCommands(cmd);

  // -----------------------------------------------------------------------
  // eidolon mcp serve
  // -----------------------------------------------------------------------
  cmd
    .command("serve")
    .description("Start the Eidolon memory MCP server on stdio (for use as an MCP server in Claude Code, Cline, etc.)")
    .option("--db <path>", "Path to memory.db (defaults to standard data directory)")
    .action(async (options: { readonly db?: string }) => {
      // Resolve the memory database path
      const dbPath = options.db ?? join(getDataDir(), MEMORY_DB_FILENAME);

      if (!existsSync(dbPath) && !options.db) {
        console.error(`Error: Memory database not found at ${dbPath}`);
        console.error("Make sure Eidolon has been started at least once, or specify --db <path>.");
        process.exitCode = 1;
        return;
      }

      // Create a stderr-only logger so stdout stays clean for MCP protocol
      const logger = createStderrLogger();

      // Open the memory database (read-write for memory_add)
      const connResult = createConnection(dbPath, { walMode: true });
      if (!connResult.ok) {
        console.error(`Error: Failed to open database at ${dbPath}: ${connResult.error.message}`);
        process.exitCode = 1;
        return;
      }

      const db = connResult.value;

      // Run migrations to ensure schema is up to date
      const migrationResult = runMigrations(db, "memory", MEMORY_MIGRATIONS, logger);
      if (!migrationResult.ok) {
        console.error(`Error: Failed to run migrations: ${migrationResult.error.message}`);
        db.close();
        process.exitCode = 1;
        return;
      }

      // Initialize stores
      const store = new MemoryStore(db, logger);
      const kgEntities = new KGEntityStore(db, logger);
      const kgRelations = new KGRelationStore(db, logger);

      // Start the MCP server (search=null since we don't have embeddings in CLI)
      const server = new MemoryMcpServer({
        store,
        search: null,
        kgEntities,
        kgRelations,
        logger,
      });

      // Handle graceful shutdown
      const shutdown = (): void => {
        server.stop();
        db.close();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await server.start();

      // Clean up after server stops
      db.close();
    });
}

/**
 * Create a logger that writes to stderr only (keeps stdout clean for MCP protocol).
 * Uses a minimal inline implementation to avoid pulling in the full logging stack.
 */
function createStderrLogger(): {
  debug(module: string, message: string, data?: Record<string, unknown>): void;
  info(module: string, message: string, data?: Record<string, unknown>): void;
  warn(module: string, message: string, data?: Record<string, unknown>): void;
  error(module: string, message: string, error?: unknown, data?: Record<string, unknown>): void;
  child(module: string): ReturnType<typeof createStderrLogger>;
} {
  const write = (level: string, module: string, message: string): void => {
    process.stderr.write(`[${level}] ${module}: ${message}\n`);
  };
  return {
    debug: () => {},
    info: (mod, msg) => write("INFO", mod, msg),
    warn: (mod, msg) => write("WARN", mod, msg),
    error: (mod, msg) => write("ERROR", mod, msg),
    child: () => createStderrLogger(),
  };
}
