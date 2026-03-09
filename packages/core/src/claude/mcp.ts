/**
 * MCP (Model Context Protocol) server configuration passthrough.
 *
 * Generates the JSON config file that Claude Code CLI accepts via
 * the --mcp-config flag. Reads server definitions from BrainConfig.
 *
 * Supports resolving `$secret:KEY_NAME` references in env values
 * from the encrypted secret store.
 */

import { chmodSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BrainConfig, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

/**
 * MCP server configuration format for Claude Code CLI.
 * The --mcp-config flag accepts a JSON file with this structure.
 */
interface McpConfigFile {
  readonly mcpServers: Record<
    string,
    {
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Record<string, string>;
    }
  >;
}

/**
 * Function type for resolving secrets by key name.
 * Returns the decrypted value on success, or an error.
 */
export type SecretResolver = (key: string) => Result<string, EidolonError>;

/** Prefix that marks an env value as a secret reference (e.g. "$secret:HA_TOKEN"). */
const SECRET_PREFIX = "$secret:";

/**
 * Resolve `$secret:KEY_NAME` references in MCP server env values.
 * Returns a new servers record with secrets replaced by their decrypted values.
 */
function resolveEnvSecrets(
  servers: Record<
    string,
    { readonly command: string; readonly args?: readonly string[]; readonly env?: Record<string, string> }
  >,
  resolver: SecretResolver,
): Result<McpConfigFile["mcpServers"], EidolonError> {
  const resolved: Record<string, { command: string; args?: readonly string[]; env?: Record<string, string> }> = {};

  for (const [name, server] of Object.entries(servers)) {
    if (!server.env) {
      resolved[name] = { command: server.command, args: server.args };
      continue;
    }

    const resolvedEnv: Record<string, string> = {};
    for (const [envKey, envValue] of Object.entries(server.env)) {
      if (envValue.startsWith(SECRET_PREFIX)) {
        const secretKey = envValue.slice(SECRET_PREFIX.length);
        const secretResult = resolver(secretKey);
        if (!secretResult.ok) {
          return Err(
            createError(
              ErrorCode.SECRET_NOT_FOUND,
              `Failed to resolve secret "${secretKey}" for MCP server "${name}" env var "${envKey}": ${secretResult.error.message}`,
            ),
          );
        }
        resolvedEnv[envKey] = secretResult.value;
      } else {
        resolvedEnv[envKey] = envValue;
      }
    }

    resolved[name] = { command: server.command, args: server.args, env: resolvedEnv };
  }

  return Ok(resolved);
}

/** Name of the MCP config file written to workspace directories. */
const MCP_CONFIG_FILENAME = ".mcp-servers.json";

/**
 * Remove stale `.mcp-servers.json` files from a workspace directory.
 *
 * If the daemon crashes, MCP config files containing resolved secrets
 * may persist on disk. Call this during daemon init to clean them up.
 * Scans immediate subdirectories of `workspaceDir` (one level deep,
 * matching the WorkspacePreparer layout).
 */
export function cleanupStaleMcpConfigs(workspaceDir: string): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(workspaceDir);
  } catch {
    // Directory may not exist yet -- nothing to clean
    return 0;
  }
  for (const entry of entries) {
    const configPath = join(workspaceDir, entry, MCP_CONFIG_FILENAME);
    try {
      unlinkSync(configPath);
      removed++;
    } catch {
      // File doesn't exist or can't be removed -- skip
    }
  }
  return removed;
}

/**
 * Generate an MCP config file for Claude Code CLI.
 * Writes the file to the workspace directory and returns the path.
 * Returns null if no MCP servers are configured.
 *
 * If a `secretResolver` is provided, env values prefixed with `$secret:`
 * are resolved from the encrypted secret store before writing the file.
 * The file is written with 0o600 permissions.
 *
 * Use the returned `cleanup` function to remove the config file after
 * the session ends (prevents secrets lingering on disk).
 */
export async function generateMcpConfig(
  workspaceDir: string,
  brainConfig: BrainConfig,
  secretResolver?: SecretResolver,
): Promise<Result<{ path: string; cleanup: () => void } | null, EidolonError>> {
  if (!brainConfig.mcpServers || Object.keys(brainConfig.mcpServers).length === 0) {
    return Ok(null);
  }

  let mcpServers: McpConfigFile["mcpServers"];

  if (secretResolver) {
    const resolveResult = resolveEnvSecrets(brainConfig.mcpServers, secretResolver);
    if (!resolveResult.ok) return resolveResult;
    mcpServers = resolveResult.value;
  } else {
    mcpServers = brainConfig.mcpServers;
  }

  const mcpConfig: McpConfigFile = { mcpServers };
  const configPath = join(workspaceDir, MCP_CONFIG_FILENAME);

  try {
    await Bun.write(configPath, JSON.stringify(mcpConfig, null, 2));
    // SEC-H5: MCP config may contain env vars with secrets (e.g. HA_TOKEN).
    // Restrict file permissions to owner-only to prevent other users from reading.
    try {
      chmodSync(configPath, 0o600);
    } catch {
      // Non-fatal: may fail on some filesystems (e.g. FAT32 on Windows)
    }

    const cleanup = (): void => {
      try {
        unlinkSync(configPath);
      } catch {
        // Best-effort: file may have already been removed
      }
    };

    return Ok({ path: configPath, cleanup });
  } catch (cause) {
    return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, "Failed to write MCP config", cause));
  }
}
