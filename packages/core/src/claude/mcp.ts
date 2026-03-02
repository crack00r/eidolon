/**
 * MCP (Model Context Protocol) server configuration passthrough.
 *
 * Generates the JSON config file that Claude Code CLI accepts via
 * the --mcp-config flag. Reads server definitions from BrainConfig.
 */

import { chmodSync } from "node:fs";
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
 * Generate an MCP config file for Claude Code CLI.
 * Writes the file to the workspace directory and returns the path.
 * Returns null if no MCP servers are configured.
 */
export async function generateMcpConfig(
  workspaceDir: string,
  brainConfig: BrainConfig,
): Promise<Result<string | null, EidolonError>> {
  if (!brainConfig.mcpServers || Object.keys(brainConfig.mcpServers).length === 0) {
    return Ok(null);
  }

  const mcpConfig: McpConfigFile = {
    mcpServers: brainConfig.mcpServers,
  };

  const configPath = join(workspaceDir, ".mcp-servers.json");

  try {
    await Bun.write(configPath, JSON.stringify(mcpConfig, null, 2));
    // SEC-H5: MCP config may contain env vars with secrets (e.g. HA_TOKEN).
    // Restrict file permissions to owner-only to prevent other users from reading.
    try {
      chmodSync(configPath, 0o600);
    } catch {
      // Non-fatal: may fail on some filesystems (e.g. FAT32 on Windows)
    }
    return Ok(configPath);
  } catch (cause) {
    return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, "Failed to write MCP config", cause));
  }
}
