/**
 * Shared types for the MCP Marketplace module.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Installation status
// ---------------------------------------------------------------------------

export const McpInstallStatusSchema = z.enum([
  "available",
  "installing",
  "installed",
  "configured",
  "failed",
  "removing",
]);

export type McpInstallStatus = z.infer<typeof McpInstallStatusSchema>;

// ---------------------------------------------------------------------------
// Installed server record (persisted)
// ---------------------------------------------------------------------------

export const InstalledMcpServerSchema = z.object({
  /** Template ID from the catalog. */
  templateId: z.string(),
  /** Display name (may differ from template if user overrode it). */
  name: z.string(),
  /** npm package name. */
  packageName: z.string(),
  /** Current installation status. */
  status: McpInstallStatusSchema,
  /** Absolute path to the installed package directory (if npm-installed). */
  installPath: z.string().optional(),
  /** When the server was installed (epoch ms). */
  installedAt: z.number(),
  /** When the status last changed (epoch ms). */
  updatedAt: z.number(),
  /** Error message if status is "failed". */
  error: z.string().optional(),
  /** Whether the server is configured in the active brain config. */
  configuredInBrain: z.boolean().default(false),
});

export type InstalledMcpServer = z.infer<typeof InstalledMcpServerSchema>;

// ---------------------------------------------------------------------------
// Discovery match result
// ---------------------------------------------------------------------------

export const McpDiscoveryMatchSchema = z.object({
  /** Template ID. */
  templateId: z.string(),
  /** Confidence score (0-1). */
  confidence: z.number().min(0).max(1),
  /** Explanation of why this server matches. */
  reasoning: z.string(),
});

export type McpDiscoveryMatch = z.infer<typeof McpDiscoveryMatchSchema>;

export const McpDiscoveryResponseSchema = z.object({
  matches: z.array(McpDiscoveryMatchSchema),
});

export type McpDiscoveryResponse = z.infer<typeof McpDiscoveryResponseSchema>;

// ---------------------------------------------------------------------------
// Configuration status for a server
// ---------------------------------------------------------------------------

export interface McpConfigStatus {
  readonly templateId: string;
  readonly isInstalled: boolean;
  readonly isConfigured: boolean;
  readonly missingSecrets: readonly string[];
  readonly hasAllSecrets: boolean;
}

// ---------------------------------------------------------------------------
// Installer result
// ---------------------------------------------------------------------------

export interface McpInstallResult {
  readonly templateId: string;
  readonly packageName: string;
  readonly installPath: string;
  readonly version: string;
}

export interface McpRemoveResult {
  readonly templateId: string;
  readonly packageName: string;
}
