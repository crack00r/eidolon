/**
 * Plugin registry -- tracks installed plugins and their states.
 */

import type { PluginInfo, PluginState } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { LoadedPlugin } from "./loader.ts";

export class PluginRegistry {
  private readonly plugins = new Map<string, PluginInfo>();

  constructor(private readonly logger: Logger) {}

  register(loaded: LoadedPlugin, state: PluginState): void {
    const info: PluginInfo = {
      manifest: loaded.manifest,
      state,
      loadedAt: Date.now(),
      directory: loaded.directory,
    };
    this.plugins.set(loaded.manifest.name, info);
    this.logger.info("plugins:registry", `Registered plugin ${loaded.manifest.name} (${state})`);
  }

  updateState(name: string, state: PluginState, error?: string): void {
    const existing = this.plugins.get(name);
    if (!existing) return;

    const updated: PluginInfo = {
      ...existing,
      state,
      error,
      startedAt: state === "started" ? Date.now() : existing.startedAt,
    };
    this.plugins.set(name, updated);
  }

  get(name: string): PluginInfo | undefined {
    return this.plugins.get(name);
  }

  getAll(): readonly PluginInfo[] {
    return [...this.plugins.values()];
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  remove(name: string): boolean {
    return this.plugins.delete(name);
  }
}
