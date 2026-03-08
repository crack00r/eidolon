/**
 * Plugin loader -- discovers and loads plugin packages from the configured
 * directory.  Each plugin is an npm package with an `eidolon-plugin.json`
 * manifest or an `"eidolon"` key in its `package.json`.
 *
 * SECURITY NOTE: Plugin loading executes arbitrary code via dynamic `import()`.
 * There is no sandboxing -- plugins run with the same privileges as the daemon.
 * Security relies on:
 *   1. The plugin directory being writable only by root or the daemon user.
 *   2. Plugins being installed deliberately by the system administrator.
 *   3. Manifest validation via Zod (PluginManifestSchema) to reject malformed metadata.
 *   4. Path traversal prevention: the resolved entry path must stay within the plugin dir.
 *
 * A full V8 isolate or WASM sandbox is out of scope for the current architecture.
 * Treat the plugin directory as a trusted code boundary, equivalent to node_modules.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionPointType, PluginManifest, PluginPermission } from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Zod schema for plugin manifest validation
// ---------------------------------------------------------------------------

const PluginPermissionSchema = z.enum([
  "events:listen",
  "events:emit",
  "memory:read",
  "memory:write",
  "config:read",
  "config:write",
  "gateway:register",
  "channel:register",
  "shell:execute",
  "filesystem:write",
]) satisfies z.ZodType<PluginPermission>;

const ExtensionPointTypeSchema = z.enum([
  "channel",
  "rpc-handler",
  "event-listener",
  "memory-extractor",
  "cli-command",
  "config-schema",
]) satisfies z.ZodType<ExtensionPointType>;

const ExtensionPointSchema = z.object({
  type: ExtensionPointTypeSchema,
  name: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});

export const PluginManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  author: z.string().optional(),
  eidolonVersion: z.string().min(1),
  permissions: z.array(PluginPermissionSchema),
  extensionPoints: z.array(ExtensionPointSchema),
  main: z.string().min(1),
});

export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  readonly directory: string;
  readonly module: Record<string, unknown>;
}

/**
 * Scan `pluginDir` for valid Eidolon plugins and dynamically import them.
 */
export async function discoverPlugins(pluginDir: string, logger: Logger): Promise<readonly LoadedPlugin[]> {
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

      // Validate that entryPath resolves within the plugin directory
      // to prevent path traversal attacks (e.g., main: "../../etc/passwd")
      const entryPath = resolve(dir, manifest.main);
      const resolvedDir = resolve(dir);
      if (!entryPath.startsWith(resolvedDir + "/") && entryPath !== resolvedDir) {
        logger.warn("plugins:loader", `Plugin ${manifest.name}: path traversal detected in main: ${manifest.main}`);
        continue;
      }

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
    const raw: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const result = PluginManifestSchema.safeParse(raw);
    if (!result.success) {
      return undefined;
    }
    return result.data;
  }

  const pkgPath = join(dir, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
    if (pkg.eidolon && typeof pkg.eidolon === "object") {
      const result = PluginManifestSchema.safeParse(pkg.eidolon);
      if (!result.success) {
        return undefined;
      }
      return result.data;
    }
  }

  return undefined;
}
