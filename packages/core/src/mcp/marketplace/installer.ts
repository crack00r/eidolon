/**
 * MCP Marketplace Installer -- handles npm-based installation and removal of MCP servers.
 *
 * Servers are installed into a dedicated directory within the Eidolon data dir.
 * Uses `npm install` for installation and `npm uninstall` for removal.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { getMcpTemplate } from "../templates.ts";
import type { MarketplaceRegistry } from "./registry.ts";
import type { McpInstallResult, McpRemoveResult } from "./types.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MCP_INSTALL_DIR_NAME = "mcp-servers";
const INSTALL_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validatePathContainment(baseDir: string, targetPath: string): void {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  if (!resolvedTarget.startsWith(`${resolvedBase}/`) && resolvedTarget !== resolvedBase) {
    throw new Error(`Path traversal detected: ${targetPath} escapes base directory`);
  }
}

function validateTemplateId(templateId: string): void {
  if (templateId.includes("..") || templateId.includes("/") || templateId.includes("\\")) {
    throw new Error(`Invalid template ID: ${templateId}`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(templateId)) {
    throw new Error(`Template ID contains unsafe characters: ${templateId}`);
  }
}

/** Extract the npm package name from template args (first arg after -y in npx). */
function extractPackageName(args: readonly string[]): string | undefined {
  const yIndex = args.indexOf("-y");
  if (yIndex !== -1 && yIndex + 1 < args.length) {
    return args[yIndex + 1];
  }
  // Fallback: use the last arg
  return args.length > 0 ? args[args.length - 1] : undefined;
}

// ---------------------------------------------------------------------------
// McpInstaller
// ---------------------------------------------------------------------------

export class McpInstaller {
  private readonly installDir: string;
  private readonly logger: Logger;
  private readonly registry: MarketplaceRegistry;

  constructor(dataDir: string, registry: MarketplaceRegistry, logger: Logger) {
    this.installDir = join(dataDir, MCP_INSTALL_DIR_NAME);
    this.registry = registry;
    this.logger = logger.child("mcp-installer");
    this.ensureInstallDir();
  }

  /** Get the base installation directory. */
  getInstallDir(): string {
    return this.installDir;
  }

  /** Install an MCP server by template ID. */
  async install(templateId: string): Promise<Result<McpInstallResult, EidolonError>> {
    try {
      validateTemplateId(templateId);
    } catch (e) {
      return Err(createError(ErrorCode.INVALID_INPUT, e instanceof Error ? e.message : String(e)));
    }

    const template = getMcpTemplate(templateId);
    if (!template) {
      return Err(createError(ErrorCode.CONFIG_NOT_FOUND, `Unknown MCP template: ${templateId}`));
    }

    const packageName = extractPackageName(template.args);
    if (!packageName) {
      return Err(
        createError(
          ErrorCode.CONFIG_INVALID,
          `Cannot determine package name from template args: ${template.args.join(" ")}`,
        ),
      );
    }

    const serverDir = join(this.installDir, templateId);
    validatePathContainment(this.installDir, serverDir);

    // Mark as installing
    this.registry.upsert({
      templateId,
      name: template.name,
      packageName,
      status: "installing",
      installPath: serverDir,
      installedAt: Date.now(),
      updatedAt: Date.now(),
      configuredInBrain: false,
    });

    try {
      this.logger.info("install", `Installing MCP server ${templateId} (${packageName})...`);

      // Create server directory and init package.json
      if (!existsSync(serverDir)) {
        mkdirSync(serverDir, { recursive: true });
      }

      // Initialize package.json if not exists
      const pkgJsonPath = join(serverDir, "package.json");
      if (!existsSync(pkgJsonPath)) {
        await Bun.write(pkgJsonPath, JSON.stringify({ name: `mcp-${templateId}`, private: true }, null, 2));
      }

      // Run npm install
      const proc = Bun.spawn(["npm", "install", packageName], {
        cwd: serverDir,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NODE_ENV: "production" },
      });

      const exitCode = await Promise.race([
        proc.exited,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), INSTALL_TIMEOUT_MS)),
      ]);

      if (exitCode === "timeout") {
        try {
          proc.kill();
        } catch {
          /* best effort */
        }
        const error = `Installation timed out after ${INSTALL_TIMEOUT_MS}ms`;
        this.registry.updateStatus(templateId, "failed", error);
        return Err(createError(ErrorCode.TIMEOUT, error));
      }

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        const error = `npm install failed with code ${String(exitCode)}: ${stderr.slice(0, 500)}`;
        this.registry.updateStatus(templateId, "failed", error);
        return Err(createError(ErrorCode.CONFIG_INVALID, error));
      }

      // Determine installed version
      const version = await this.getInstalledVersion(serverDir, packageName);

      // Update registry
      this.registry.upsert({
        templateId,
        name: template.name,
        packageName,
        status: "installed",
        installPath: serverDir,
        installedAt: Date.now(),
        updatedAt: Date.now(),
        configuredInBrain: false,
      });

      this.logger.info("install", `Successfully installed ${packageName}@${version}`);

      return Ok({ templateId, packageName, installPath: serverDir, version });
    } catch (cause) {
      const error = `Installation failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      this.registry.updateStatus(templateId, "failed", error);
      return Err(createError(ErrorCode.CONFIG_INVALID, error, cause));
    }
  }

  /** Remove an installed MCP server. */
  async remove(templateId: string): Promise<Result<McpRemoveResult, EidolonError>> {
    try {
      validateTemplateId(templateId);
    } catch (e) {
      return Err(createError(ErrorCode.INVALID_INPUT, e instanceof Error ? e.message : String(e)));
    }

    const installed = this.registry.get(templateId);
    if (!installed || installed.status === "available") {
      return Err(createError(ErrorCode.CONFIG_NOT_FOUND, `MCP server ${templateId} is not installed`));
    }

    this.registry.updateStatus(templateId, "removing");

    try {
      const serverDir = join(this.installDir, templateId);
      validatePathContainment(this.installDir, serverDir);

      if (existsSync(serverDir)) {
        rmSync(serverDir, { recursive: true, force: true });
      }

      this.registry.remove(templateId);
      this.logger.info("remove", `Removed MCP server ${templateId}`);

      return Ok({ templateId, packageName: installed.packageName });
    } catch (cause) {
      const error = `Removal failed: ${cause instanceof Error ? cause.message : String(cause)}`;
      this.registry.updateStatus(templateId, "failed", error);
      return Err(createError(ErrorCode.CONFIG_INVALID, error, cause));
    }
  }

  /** Check if a template is installed. */
  isInstalled(templateId: string): boolean {
    const record = this.registry.get(templateId);
    return record?.status === "installed" || record?.status === "configured";
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private ensureInstallDir(): void {
    if (!existsSync(this.installDir)) {
      mkdirSync(this.installDir, { recursive: true });
    }
  }

  private async getInstalledVersion(serverDir: string, packageName: string): Promise<string> {
    try {
      const pkgPath = join(serverDir, "node_modules", packageName, "package.json");
      const raw = await Bun.file(pkgPath).text();
      const pkg = JSON.parse(raw) as { version?: string };
      return pkg.version ?? "unknown";
    } catch {
      return "unknown";
    }
  }
}
