/**
 * Workspace preparation for Claude Code sessions.
 *
 * Each session gets its own workspace directory with context files
 * (CLAUDE.md, SOUL.md, etc.) injected before the subprocess starts.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { getCacheDir } from "../config/paths.js";
import type { Logger } from "../logging/logger.js";

export interface WorkspaceContent {
  /** Content for CLAUDE.md -- system instructions for this session */
  readonly claudeMd: string;
  /** Content for SOUL.md -- personality and style guide (optional) */
  readonly soulMd?: string;
  /** Additional files to write to workspace */
  readonly additionalFiles?: Record<string, string>;
}

/**
 * Prepares workspace directories for Claude Code sessions.
 * Each session gets its own workspace with context files.
 */
export class WorkspacePreparer {
  private readonly workspacesDir: string;
  private readonly logger: Logger;

  constructor(logger: Logger, workspacesDir?: string) {
    this.workspacesDir = workspacesDir ?? join(getCacheDir(), "workspaces");
    this.logger = logger.child("workspace");
    // Ensure workspaces directory exists
    if (!existsSync(this.workspacesDir)) {
      mkdirSync(this.workspacesDir, { recursive: true });
    }
  }

  /** Create a workspace for a session */
  async prepare(sessionId: string, content: WorkspaceContent): Promise<Result<string, EidolonError>> {
    const workspaceDir = join(this.workspacesDir, sessionId);
    try {
      mkdirSync(workspaceDir, { recursive: true });

      // Write CLAUDE.md
      await Bun.write(join(workspaceDir, "CLAUDE.md"), content.claudeMd);

      // Write SOUL.md if provided
      if (content.soulMd) {
        await Bun.write(join(workspaceDir, "SOUL.md"), content.soulMd);
      }

      // Write additional files
      if (content.additionalFiles) {
        for (const [filename, fileContent] of Object.entries(content.additionalFiles)) {
          await Bun.write(join(workspaceDir, filename), fileContent);
        }
      }

      this.logger.debug("workspace", `Prepared workspace for ${sessionId}`, { dir: workspaceDir });
      return Ok(workspaceDir);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_CONNECTION_FAILED, `Failed to prepare workspace: ${workspaceDir}`, cause));
    }
  }

  /** Clean up a workspace after session completes */
  cleanup(sessionId: string): void {
    const workspaceDir = join(this.workspacesDir, sessionId);
    if (existsSync(workspaceDir)) {
      rmSync(workspaceDir, { recursive: true });
      this.logger.debug("workspace", `Cleaned up workspace ${sessionId}`);
    }
  }

  /** Clean up all workspaces older than maxAgeMs */
  cleanupOld(maxAgeMs: number): number {
    let cleaned = 0;
    if (!existsSync(this.workspacesDir)) return 0;

    const now = Date.now();
    const entries = readdirSync(this.workspacesDir);
    for (const entry of entries) {
      const path = join(this.workspacesDir, entry);
      try {
        const stats = statSync(path);
        if (now - stats.mtimeMs >= maxAgeMs) {
          rmSync(path, { recursive: true });
          cleaned++;
        }
      } catch {
        // Ignore stat errors
      }
    }
    if (cleaned > 0) {
      this.logger.info("workspace", `Cleaned up ${cleaned} old workspaces`);
    }
    return cleaned;
  }
}
