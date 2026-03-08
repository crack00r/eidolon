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
import { createError, Err, ErrorCode } from "@eidolon/protocol";
import { getConfigPath } from "./paths.ts";
import { validateAndResolve } from "./validator.ts";

/**
 * Migrate legacy config field names to current names.
 * This allows old config files to keep working after renames.
 */
function migrateConfig(raw: Record<string, unknown>): Record<string, unknown> {
  // Migrate brain.claudeAccounts → brain.accounts
  const brain = raw.brain as Record<string, unknown> | undefined;
  if (brain && "claudeAccounts" in brain && !("accounts" in brain)) {
    brain.accounts = brain.claudeAccounts;
    delete brain.claudeAccounts;
  }
  return raw;
}

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

  // Migrate legacy field names before validation
  const migrated = migrateConfig(parsed as Record<string, unknown>);

  // Validate with Zod and resolve
  return validateAndResolve(migrated);
}
