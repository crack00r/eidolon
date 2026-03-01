/**
 * Load, validate, and resolve the Eidolon configuration.
 *
 * Lookup order:
 * 1. Explicit path argument
 * 2. EIDOLON_CONFIG environment variable
 * 3. ./eidolon.json (current directory)
 * 4. Platform-specific config directory
 */

import { join } from "node:path";
import type { EidolonConfig, EidolonError, Result } from "@eidolon/protocol";
import { createError, EidolonConfigSchema, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { resolveDefaults } from "./defaults.js";
import { applyEnvOverrides } from "./env.js";
import { getConfigPath } from "./paths.js";

export async function loadConfig(path?: string): Promise<Result<EidolonConfig, EidolonError>> {
  // Determine config file path
  const configPath = path ?? getConfigPath();

  // Check if config file exists
  const file = Bun.file(configPath);
  const exists = await file.exists();

  // Also check current directory (only when no explicit path or env var)
  const cwdPath = join(process.cwd(), "eidolon.json");
  const cwdFile = Bun.file(cwdPath);
  const cwdExists = !path && !process.env.EIDOLON_CONFIG && (await cwdFile.exists());

  let rawJson: string;
  let usedPath: string;

  if (exists) {
    rawJson = await file.text();
    usedPath = configPath;
  } else if (cwdExists) {
    rawJson = await cwdFile.text();
    usedPath = cwdPath;
  } else {
    return Err(
      createError(
        ErrorCode.CONFIG_NOT_FOUND,
        `Config file not found. Searched: ${configPath}${!path ? `, ${cwdPath}` : ""}`,
      ),
    );
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    return Err(createError(ErrorCode.CONFIG_PARSE_ERROR, `Invalid JSON in ${usedPath}`, cause));
  }

  // Validate with Zod and resolve
  return validateAndResolve(parsed);
}

/**
 * Validate raw config data and resolve defaults.
 * Can be used standalone without loading from file.
 */
export function validateAndResolve(raw: unknown): Result<EidolonConfig, EidolonError> {
  const result = EidolonConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return Err(createError(ErrorCode.CONFIG_INVALID, `Config validation failed: ${issues}`));
  }

  // Apply environment overrides
  const withEnv = applyEnvOverrides(result.data);

  // Resolve platform-specific defaults
  const resolved = resolveDefaults(withEnv);

  return Ok(resolved);
}
