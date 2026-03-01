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

export function applyEnvOverrides(config: EidolonConfig): EidolonConfig {
  const result = structuredClone(config) as Record<string, unknown>;

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(ENV_PREFIX) || value === undefined) continue;

    const path = key.slice(ENV_PREFIX.length).toLowerCase().split("_");

    if (path.length < 2) continue; // need at least section.key

    // Only process env vars whose first segment matches a config section
    const firstSegment = path[0];
    if (firstSegment === undefined || !CONFIG_SECTIONS.has(firstSegment)) continue;

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
