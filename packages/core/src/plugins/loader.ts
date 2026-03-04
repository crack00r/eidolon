/**
 * Plugin loader -- discovers and loads plugin packages from the configured
 * directory.  Each plugin is an npm package with an `eidolon-plugin.json`
 * manifest or an `"eidolon"` key in its `package.json`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginManifest } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly directory: string;
  readonly module: Record<string, unknown>;
}

/**
 * Scan `pluginDir` for valid Eidolon plugins and dynamically import them.
 */
export async function discoverPlugins(
  pluginDir: string,
  logger: Logger,
): Promise<readonly LoadedPlugin[]> {
  if (!pluginDir || !existsSync(pluginDir)) {
    logger.debug("plugins:loader", "Plugin directory does not exist, skipping", { pluginDir });
    return [];
  }

  const entries = readdirSync(pluginDir, { withFileTypes: true });
  const results: LoadedPlugin[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = join(pluginDir, entry.name);
    try {
      const manifest = readManifest(dir);
      if (!manifest) {
        logger.debug("plugins:loader", `Skipping ${entry.name}: no manifest found`);
        continue;
      }

      const entryPath = join(dir, manifest.main);
      if (!existsSync(entryPath)) {
        logger.warn("plugins:loader", `Plugin ${manifest.name}: entry ${manifest.main} not found`);
        continue;
      }

      const mod = (await import(entryPath)) as Record<string, unknown>;
      results.push({ manifest, directory: dir, module: mod });
      logger.info("plugins:loader", `Loaded plugin ${manifest.name}@${manifest.version}`);
    } catch (err) {
      logger.error("plugins:loader", `Failed to load plugin from ${dir}`, err);
    }
  }

  return results;
}

/**
 * Read the plugin manifest from `eidolon-plugin.json` or `package.json#eidolon`.
 */
function readManifest(dir: string): PluginManifest | undefined {
  const manifestPath = join(dir, "eidolon-plugin.json");
  if (existsSync(manifestPath)) {
    return JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
  }

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    if (pkg["eidolon"] && typeof pkg["eidolon"] === "object") {
      return pkg["eidolon"] as PluginManifest;
    }
  }

  return undefined;
}
