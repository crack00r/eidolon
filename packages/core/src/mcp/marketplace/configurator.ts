/**
 * MCP Marketplace Configurator -- generates and applies MCP server config.
 *
 * Handles:
 * - Generating BrainConfig mcpServers entries from templates
 * - Detecting missing secrets
 * - Merging new servers into existing config
 */

import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { getMcpTemplate, type McpTemplate, templateToConfigEntry } from "../templates.ts";
import type { MarketplaceRegistry } from "./registry.ts";
import type { McpConfigStatus } from "./types.ts";

/**
 * Zod schema for the subset of config structure we read/write.
 * We only require `brain.mcpServers` to be a record of objects.
 */
const ConfigFileSchema = z
  .object({
    brain: z
      .object({
        mcpServers: z.record(z.record(z.unknown())).default({}),
      })
      .passthrough()
      .default({}),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerEntry {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
}

interface ConfigApplyResult {
  readonly templateId: string;
  readonly serverName: string;
  readonly missingSecrets: readonly string[];
  readonly applied: boolean;
}

// ---------------------------------------------------------------------------
// McpConfigurator
// ---------------------------------------------------------------------------

export class McpConfigurator {
  private readonly registry: MarketplaceRegistry;
  private readonly logger: Logger;

  constructor(registry: MarketplaceRegistry, logger: Logger) {
    this.registry = registry;
    this.logger = logger.child("mcp-configurator");
  }

  /**
   * Generate a config entry for a template.
   * Returns the entry and any missing secrets.
   */
  generateEntry(
    templateId: string,
    availableSecrets: ReadonlySet<string>,
  ): Result<{ entry: McpServerEntry; missingSecrets: readonly string[] }, EidolonError> {
    const template = getMcpTemplate(templateId);
    if (!template) {
      return Err(createError(ErrorCode.CONFIG_NOT_FOUND, `Unknown MCP template: ${templateId}`));
    }

    const entry = templateToConfigEntry(template);
    const missingSecrets = template.requiredSecrets.filter((s) => !availableSecrets.has(s));

    return Ok({ entry, missingSecrets });
  }

  /**
   * Apply a template to a config file (add it to brain.mcpServers).
   * Returns info about what was applied and any missing secrets.
   */
  applyToConfig(
    configPath: string,
    templateId: string,
    availableSecrets: ReadonlySet<string>,
    serverName?: string,
  ): Result<ConfigApplyResult, EidolonError> {
    const template = getMcpTemplate(templateId);
    if (!template) {
      return Err(createError(ErrorCode.CONFIG_NOT_FOUND, `Unknown MCP template: ${templateId}`));
    }

    const name = serverName ?? templateId;

    // Read and validate existing config
    let config: z.infer<typeof ConfigFileSchema>;
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const validated = ConfigFileSchema.safeParse(parsed);
      if (!validated.success) {
        return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, `Invalid config structure at ${configPath}: ${validated.error.message}`));
      }
      config = validated.data;
    } catch (cause) {
      return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, `Failed to read config at ${configPath}`, cause));
    }

    // Navigate to brain.mcpServers
    const brain = config.brain;
    const mcpServers = brain.mcpServers;

    // Check if already exists
    if (name in mcpServers) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `MCP server "${name}" already exists in config`));
    }

    // Generate entry
    const entry = templateToConfigEntry(template);
    const missingSecrets = template.requiredSecrets.filter((s) => !availableSecrets.has(s));

    // Apply
    mcpServers[name] = entry;
    brain.mcpServers = mcpServers;
    config.brain = brain;

    // Write back
    try {
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    } catch (cause) {
      return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, `Failed to write config at ${configPath}`, cause));
    }

    // Update registry
    this.registry.upsert({
      templateId,
      name: template.name,
      packageName: extractPackageFromTemplate(template),
      status: "configured",
      installedAt: Date.now(),
      updatedAt: Date.now(),
      configuredInBrain: true,
    });

    this.logger.info("apply", `Applied MCP server ${templateId} as "${name}" to config`);

    return Ok({
      templateId,
      serverName: name,
      missingSecrets,
      applied: true,
    });
  }

  /**
   * Remove a server from the config file (from brain.mcpServers).
   */
  removeFromConfig(configPath: string, serverName: string): Result<boolean, EidolonError> {
    let config: z.infer<typeof ConfigFileSchema>;
    try {
      const raw = readFileSync(configPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      const validated = ConfigFileSchema.safeParse(parsed);
      if (!validated.success) {
        return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, `Invalid config structure at ${configPath}: ${validated.error.message}`));
      }
      config = validated.data;
    } catch (cause) {
      return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, `Failed to read config at ${configPath}`, cause));
    }

    const brain = config.brain;
    const mcpServers = brain.mcpServers;

    if (!(serverName in mcpServers)) {
      return Ok(false);
    }

    delete mcpServers[serverName];
    brain.mcpServers = mcpServers;
    config.brain = brain;

    try {
      writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    } catch (cause) {
      return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, `Failed to write config at ${configPath}`, cause));
    }

    this.logger.info("remove", `Removed MCP server "${serverName}" from config`);
    return Ok(true);
  }

  /**
   * Get the configuration status for all installed servers.
   */
  getStatuses(availableSecrets: ReadonlySet<string>): readonly McpConfigStatus[] {
    const installed = this.registry.listInstalled();
    return installed.map((server) => {
      const template = getMcpTemplate(server.templateId);
      const requiredSecrets = template?.requiredSecrets ?? [];
      const missingSecrets = requiredSecrets.filter((s) => !availableSecrets.has(s));

      return {
        templateId: server.templateId,
        isInstalled: server.status === "installed" || server.status === "configured",
        isConfigured: server.configuredInBrain,
        missingSecrets,
        hasAllSecrets: missingSecrets.length === 0,
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractPackageFromTemplate(template: McpTemplate): string {
  const yIndex = template.args.indexOf("-y");
  if (yIndex !== -1 && yIndex + 1 < template.args.length) {
    return template.args[yIndex + 1] ?? template.id;
  }
  return template.args[template.args.length - 1] ?? template.id;
}
