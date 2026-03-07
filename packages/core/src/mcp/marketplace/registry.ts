/**
 * MCP Marketplace Registry -- tracks installed MCP servers persistently.
 *
 * Uses an in-memory Map backed by a SQLite table for persistence.
 * Integrates with the existing MCP template catalog.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { getMcpTemplate, listMcpTemplates, type McpTemplate } from "../templates.ts";
import { InstalledMcpServerSchema, type InstalledMcpServer, type McpConfigStatus, type McpInstallStatus } from "./types.ts";

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS mcp_installed (
    template_id   TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    package_name  TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'available',
    install_path  TEXT,
    installed_at  INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    error         TEXT,
    configured    INTEGER NOT NULL DEFAULT 0
  )
`;

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface McpInstalledRow {
  readonly template_id: string;
  readonly name: string;
  readonly package_name: string;
  readonly status: string;
  readonly install_path: string | null;
  readonly installed_at: number;
  readonly updated_at: number;
  readonly error: string | null;
  readonly configured: number;
}

function rowToServer(row: McpInstalledRow): InstalledMcpServer {
  return InstalledMcpServerSchema.parse({
    templateId: row.template_id,
    name: row.name,
    packageName: row.package_name,
    status: row.status,
    installPath: row.install_path ?? undefined,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
    error: row.error ?? undefined,
    configuredInBrain: row.configured === 1,
  });
}

// ---------------------------------------------------------------------------
// MarketplaceRegistry
// ---------------------------------------------------------------------------

export class MarketplaceRegistry {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("mcp-marketplace");
    this.db.run(CREATE_TABLE_SQL);
  }

  /** Get an installed server record by template ID. */
  get(templateId: string): InstalledMcpServer | undefined {
    const row = this.db
      .query<McpInstalledRow, [string]>("SELECT * FROM mcp_installed WHERE template_id = ?")
      .get(templateId);
    return row ? rowToServer(row) : undefined;
  }

  /** List all installed (non-available) servers. */
  listInstalled(): readonly InstalledMcpServer[] {
    const rows = this.db
      .query<McpInstalledRow, []>("SELECT * FROM mcp_installed WHERE status != 'available' ORDER BY name")
      .all();
    return rows.map(rowToServer);
  }

  /** List all servers with their install status (merges template catalog + installed). */
  listAll(): readonly (McpTemplate & { installStatus: McpInstallStatus })[] {
    const installed = new Map<string, InstalledMcpServer>();
    for (const server of this.listInstalled()) {
      installed.set(server.templateId, server);
    }

    return listMcpTemplates().map((template) => {
      const inst = installed.get(template.id);
      return {
        ...template,
        installStatus: inst?.status ?? ("available" as McpInstallStatus),
      };
    });
  }

  /** Record an installation (or update an existing record). */
  upsert(server: InstalledMcpServer): Result<void, EidolonError> {
    try {
      this.db.run(
        `INSERT INTO mcp_installed (template_id, name, package_name, status, install_path, installed_at, updated_at, error, configured)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(template_id) DO UPDATE SET
           name = excluded.name,
           package_name = excluded.package_name,
           status = excluded.status,
           install_path = excluded.install_path,
           updated_at = excluded.updated_at,
           error = excluded.error,
           configured = excluded.configured`,
        [
          server.templateId,
          server.name,
          server.packageName,
          server.status,
          server.installPath ?? null,
          server.installedAt,
          server.updatedAt,
          server.error ?? null,
          server.configuredInBrain ? 1 : 0,
        ],
      );
      this.logger.info("upsert", `Upserted MCP server ${server.templateId} (${server.status})`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to upsert MCP server ${server.templateId}`, cause));
    }
  }

  /** Update the status of an installed server. */
  updateStatus(templateId: string, status: McpInstallStatus, error?: string): Result<void, EidolonError> {
    try {
      this.db.run(
        "UPDATE mcp_installed SET status = ?, updated_at = ?, error = ? WHERE template_id = ?",
        [status, Date.now(), error ?? null, templateId],
      );
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to update status for ${templateId}`, cause));
    }
  }

  /** Remove a server record entirely. */
  remove(templateId: string): Result<boolean, EidolonError> {
    try {
      const result = this.db.run("DELETE FROM mcp_installed WHERE template_id = ?", [templateId]);
      return Ok(result.changes > 0);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to remove MCP server ${templateId}`, cause));
    }
  }

  /** Check configuration status for a template (installed, configured, missing secrets). */
  getConfigStatus(
    templateId: string,
    installedSecrets: ReadonlySet<string>,
  ): Result<McpConfigStatus, EidolonError> {
    const template = getMcpTemplate(templateId);
    if (!template) {
      return Err(createError(ErrorCode.CONFIG_NOT_FOUND, `Unknown MCP template: ${templateId}`));
    }

    const installed = this.get(templateId);
    const missingSecrets = template.requiredSecrets.filter((s) => !installedSecrets.has(s));

    return Ok({
      templateId,
      isInstalled: installed?.status === "installed" || installed?.status === "configured",
      isConfigured: installed?.configuredInBrain ?? false,
      missingSecrets,
      hasAllSecrets: missingSecrets.length === 0,
    });
  }
}
