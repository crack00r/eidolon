/**
 * Apply EIDOLON_* environment variable overrides to a config object.
 *
 * Convention: EIDOLON_SECTION_KEY maps to config.section.key
 * Example: EIDOLON_LOGGING_LEVEL=debug -> config.logging.level = "debug"
 * Example: EIDOLON_LOOP_ENERGYBUDGET_MAXTOKENPERHOUR=50000
 *          -> config.loop.energybudget.maxtokenperhour = 50000
 *
 * Supported types: string, number, boolean.
 */

import type { EidolonConfig } from "@eidolon/protocol";

const ENV_PREFIX = "EIDOLON_";

/** Sections that are known to be part of the config schema (lowercase). */
const CONFIG_SECTIONS = new Set([
  "identity",
  "brain",
  "loop",
  "memory",
  "learning",
  "channels",
  "gateway",
  "gpu",
  "security",
  "database",
  "logging",
  "daemon",
]);

/**
 * SEC-C2: Config paths that MUST NOT be overridden via environment variables.
 * These are security-critical sections where env-based override could bypass
 * file permission checks and locked-field protections in the config watcher.
 * Paths are matched as prefixes against the lowercased env var path segments.
 */
const LOCKED_ENV_PATHS: ReadonlySet<string> = new Set([
  "security",
  "database",
  "daemon",
]);

/**
 * SEC-C2: Specific sub-paths within otherwise-allowed sections that must not
 * be overridden via environment variables.
 */
const LOCKED_ENV_SUBPATHS: ReadonlyArray<readonly string[]> = [
  ["brain", "accounts"],
  ["gateway", "auth"],
];

/** Check whether a given config path (lowercased segments) is locked from env override. */
function isLockedEnvPath(path: readonly string[]): boolean {
  const first = path[0];
  if (first !== undefined && LOCKED_ENV_PATHS.has(first)) return true;
  for (const locked of LOCKED_ENV_SUBPATHS) {
    if (locked.length <= path.length && locked.every((seg, i) => path[i] === seg)) return true;
  }
  return false;
}

export function applyEnvOverrides(config: EidolonConfig): EidolonConfig {
  const result = structuredClone(config) as Record<string, unknown>;

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined) continue;

    const path = key.slice(ENV_PREFIX.length).toLowerCase().split("_");

    if (path.length < 2) continue; // need at least section.key

    // Only process env vars whose first segment matches a config section
    const firstSegment = path[0];
    if (firstSegment === undefined || !CONFIG_SECTIONS.has(firstSegment)) continue;

    // SEC-C2: Block env overrides for security-critical config paths
    if (isLockedEnvPath(path)) continue;

    setNestedValue(result, path, coerceValue(value));
  }

  return result as unknown as EidolonConfig;
}

function setNestedValue(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (segment === undefined) return;
    const existing = current[segment];
    if (existing === null || existing === undefined || typeof existing !== "object") {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  const lastKey = path.at(-1);
  if (lastKey !== undefined) {
    current[lastKey] = value;
  }
}

function coerceValue(value: string): string | number | boolean {
  if (value === "true") return true;
  if (value === "false") return false;

  const num = Number(value);
  if (!Number.isNaN(num) && value.trim() !== "") return num;

  return value;
}
