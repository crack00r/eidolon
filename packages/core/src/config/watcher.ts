/**
 * Watch a config file for changes and call registered handlers with the new config.
 * Only reloads if the new config is valid.
 */

import { type FSWatcher, watch } from "node:fs";
import type { EidolonConfig } from "@eidolon/protocol";
import { loadConfig } from "./loader.js";

export type ConfigChangeHandler = (config: EidolonConfig) => void;

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private readonly handlers: ConfigChangeHandler[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(
    private readonly configPath: string,
    options?: { debounceMs?: number },
  ) {
    this.debounceMs = options?.debounceMs ?? 500;
  }

  /** Register a handler for config changes */
  onChange(handler: ConfigChangeHandler): void {
    this.handlers.push(handler);
  }

  /** Start watching the config file */
  start(): void {
    if (this.watcher) return;
    this.watcher = watch(this.configPath, () => {
      this.scheduleReload();
    });
  }

  /** Stop watching */
  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = null;
  }

  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.reload();
    }, this.debounceMs);
  }

  private async reload(): Promise<void> {
    const result = await loadConfig(this.configPath);
    if (result.ok) {
      for (const handler of this.handlers) {
        handler(result.value);
      }
    }
    // If invalid, silently ignore (keep old config)
  }
}
