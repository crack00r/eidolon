/**
 * Workspace template loader.
 *
 * Reads CLAUDE.md and SOUL.md templates from the workspace/ directory
 * at the repo root and interpolates variables like {{ownerName}}.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

/** Variables available for template interpolation */
export interface TemplateVariables {
  readonly ownerName: string;
  readonly currentTime: string;
  readonly channelId: string;
  readonly sessionType: string;
  readonly [key: string]: string;
}

/** Loaded and interpolated workspace templates */
export interface WorkspaceTemplates {
  readonly claudeMd: string;
  readonly soulMd: string;
}

const TEMPLATE_VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * Interpolate {{variable}} placeholders in a template string.
 * Unknown variables are left as-is.
 */
export function interpolateTemplate(template: string, variables: TemplateVariables): string {
  return template.replace(TEMPLATE_VARIABLE_PATTERN, (_match, key: string) => {
    const value: string | undefined = variables[key];
    return value !== undefined ? value : `{{${key}}}`;
  });
}

/**
 * Resolve the workspace templates directory.
 * Searches upward from the given start directory for a `workspace/` folder
 * containing at least CLAUDE.md.
 */
export function findTemplatesDir(startDir?: string): Result<string, EidolonError> {
  // If an explicit path is given, use it or fail
  if (startDir) {
    const candidate = resolve(startDir);
    if (existsSync(join(candidate, "CLAUDE.md"))) {
      return Ok(candidate);
    }
    return Err(
      createError(ErrorCode.CONFIG_NOT_FOUND, `Workspace template directory does not contain CLAUDE.md: ${candidate}`),
    );
  }

  // Walk upward from this file's location to find repo root workspace/
  let dir = resolve(import.meta.dir);
  for (let depth = 0; depth < 10; depth++) {
    const candidate = join(dir, "workspace");
    if (existsSync(join(candidate, "CLAUDE.md"))) {
      return Ok(candidate);
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return Err(createError(ErrorCode.CONFIG_NOT_FOUND, "Could not find workspace/ template directory with CLAUDE.md"));
}

/**
 * Load workspace templates from disk and interpolate variables.
 *
 * @param variables - Values to substitute into {{placeholder}} tokens
 * @param templatesDir - Optional explicit path to the templates directory
 * @returns Interpolated CLAUDE.md and SOUL.md content
 */
export async function loadWorkspaceTemplates(
  variables: TemplateVariables,
  templatesDir?: string,
): Promise<Result<WorkspaceTemplates, EidolonError>> {
  const dirResult = findTemplatesDir(templatesDir);
  if (!dirResult.ok) {
    return dirResult;
  }

  const dir = dirResult.value;

  try {
    const claudePath = join(dir, "CLAUDE.md");
    const soulPath = join(dir, "SOUL.md");

    const claudeRaw = await Bun.file(claudePath).text();
    const claudeMd = interpolateTemplate(claudeRaw, variables);

    let soulMd: string;
    if (existsSync(soulPath)) {
      soulMd = await Bun.file(soulPath).text();
      // SOUL.md typically has no dynamic variables, but interpolate anyway
      soulMd = interpolateTemplate(soulMd, variables);
    } else {
      soulMd = "";
    }

    return Ok({ claudeMd, soulMd });
  } catch (cause) {
    return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, "Failed to load workspace templates", cause));
  }
}
