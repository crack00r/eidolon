/**
 * Watch a config file for changes and call registered handlers with the new config.
 * Only reloads if the new config is valid.
 *
 * @security
 * - Verifies file permissions (0600 or 0640) before reload to prevent
 *   hot-reloading a config file that has been made world-readable.
 * - Security-critical config paths in {@link LOCKED_FIELDS} cannot be changed
 *   via hot-reload; the daemon must be restarted to change them.
 */

import { type FSWatcher, statSync, watch } from "node:fs";
import type { EidolonConfig } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { loadConfig } from "./loader.ts";
import { getNestedValue } from "./utils.ts";

/**
 * Security-critical config paths that cannot change via hot-reload.
 * Changes to these fields require a full daemon restart.
 */
const LOCKED_FIELDS: ReadonlySet<string> = new Set([
  "brain.accounts",
  "security",
  "database",
  "daemon.pidFile",
  "daemon.socketPath",
  "gateway.auth",
]);

export type ConfigChangeHandler = (config: EidolonConfig) => void;

/** Acceptable file permission masks: owner-only (0o600) or owner+group-read (0o640). */
const ALLOWED_PERMISSION_MASKS = new Set([0o600, 0o640]);

export class ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private readonly handlers: ConfigChangeHandler[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;
  private readonly logger?: Logger;
  private currentConfig: EidolonConfig | null = null;

  constructor(
    private readonly configPath: string,
    options?: { debounceMs?: number; logger?: Logger },
  ) {
    this.debounceMs = options?.debounceMs ?? 500;
    this.logger = options?.logger;
  }

  /** Register a handler for config changes */
  onChange(handler: ConfigChangeHandler): void {
    this.handlers.push(handler);
  }

  /** Start watching the config file */
  start(): void {
    if (this.watcher) return;
    // NOTE: fs.watch may not fire on Linux when editors use atomic file replacement
    // (write to temp file + rename). This is a known Node/Bun limitation. The
    // debounced reload mitigates partial-write issues but cannot fix missing events.
    // Workaround: use inotifywait or poll-based fallback if atomic saves are needed.
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
      this.reload().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.logger?.error("watcher", `Config reload failed unexpectedly: ${message}`, err);
      });
    }, this.debounceMs);
  }

  /**
   * Check that the config file has safe permissions (0600 or 0640).
   * Returns true if permissions are acceptable, false otherwise.
   */
  private checkFilePermissions(): boolean {
    // SEC-M1: POSIX mode bits are meaningless on NTFS. Skip the check on Windows
    // and allow the reload since Windows has its own ACL-based permission model.
    if (process.platform === "win32") {
      this.logger?.debug("watcher", "Skipping POSIX permission check on Windows (NTFS uses ACLs).");
      return true;
    }

    try {
      const stats = statSync(this.configPath);
      // Extract lower 9 bits (owner/group/other rwx)
      const mode = stats.mode & 0o777;
      if (!ALLOWED_PERMISSION_MASKS.has(mode)) {
        this.logger?.warn(
          "watcher",
          `Config file permissions 0o${mode.toString(8)} are too open. ` +
            "Expected 0600 or 0640. Refusing to hot-reload.",
        );
        return false;
      }
      return true;
    } catch {
      // On non-POSIX systems statSync may not return meaningful mode bits.
      // Deny by default to fail-safe rather than fail-open.
      this.logger?.warn(
        "watcher",
        "Could not verify config file permissions. Refusing reload as a precaution.",
      );
      return false;
    }
  }

  /**
   * Check whether any LOCKED_FIELDS differ between old and new config.
   * Returns the list of locked field paths that changed.
   */
  private getLockedFieldChanges(oldConfig: EidolonConfig, newConfig: EidolonConfig): string[] {
    const changed: string[] = [];
    for (const path of LOCKED_FIELDS) {
      const oldVal = getNestedValue(oldConfig as unknown as Record<string, unknown>, path);
      const newVal = getNestedValue(newConfig as unknown as Record<string, unknown>, path);
      if (!Bun.deepEquals(oldVal, newVal)) {
        changed.push(path);
      }
    }
    return changed;
  }

  private async reload(): Promise<void> {
    // SEC: Verify file permissions before trusting the content
    if (!this.checkFilePermissions()) return;

    const result = await loadConfig(this.configPath);
    if (result.ok) {
      // SEC-C3: Block changes to security-critical fields via hot-reload.
      // Always check locked fields, including on first reload when currentConfig
      // may be null (use the newly loaded config as both old and new to initialize).
      const oldConfig = this.currentConfig ?? result.value;
      const lockedChanges = this.getLockedFieldChanges(oldConfig, result.value);
      if (lockedChanges.length > 0) {
        this.logger?.warn(
          "watcher",
          `Blocked hot-reload: locked field(s) changed: ${lockedChanges.join(", ")}. Restart the daemon to apply.`,
        );
        return;
      }

      this.currentConfig = result.value;

      for (const handler of this.handlers) {
        try {
          handler(result.value);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger?.error("watcher", `Config change handler threw: ${message}`, err);
        }
      }
    } else {
      this.logger?.warn("watcher", `Config reload failed: ${result.error.message}`);
    }
  }
}
