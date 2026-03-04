/**
 * Plugin lifecycle manager -- initializes, starts, stops, and destroys plugins.
 */

import type { EidolonPlugin, EventType, PluginPermission } from "@eidolon/protocol";
import type { PluginConfig } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { LoadedPlugin } from "./loader.ts";
import type { PluginRegistry } from "./registry.ts";
import { type SandboxDeps, createPluginContext } from "./sandbox.ts";

interface ManagedPlugin {
  readonly loaded: LoadedPlugin;
  readonly instance: EidolonPlugin;
}

export class PluginLifecycleManager {
  private readonly managed: ManagedPlugin[] = [];

  constructor(
    private readonly registry: PluginRegistry,
    private readonly config: PluginConfig,
    private readonly deps: SandboxDeps,
    private readonly logger: Logger,
    private readonly eventBus?: EventBus,
  ) {}

  /**
   * Load, validate permissions, and initialize all provided plugins.
   */
  async initAll(loadedPlugins: readonly LoadedPlugin[]): Promise<void> {
    const blocked = new Set(this.config.blockedPlugins);

    for (const loaded of loadedPlugins) {
      const name = loaded.manifest.name;
      if (blocked.has(name)) {
        this.logger.info("plugins:lifecycle", `Skipping blocked plugin ${name}`);
        this.registry.register(loaded, "discovered");
        continue;
      }

      // Permission check: only grant allowed permissions
      const granted = this.resolvePermissions(loaded.manifest.permissions);
      const denied = loaded.manifest.permissions.filter((p) => !granted.includes(p));
      if (denied.length > 0) {
        this.logger.warn("plugins:lifecycle", `Plugin ${name}: denied permissions: ${denied.join(", ")}`);
      }

      try {
        const ctx = createPluginContext(name, granted, this.deps);
        const instance = this.resolveInstance(loaded);
        await instance.init(ctx);

        this.managed.push({ loaded, instance });
        this.registry.register(loaded, "initialized");
        this.logger.info("plugins:lifecycle", `Plugin ${name} initialized`);
      } catch (err) {
        this.registry.register(loaded, "error");
        this.registry.updateState(name, "error", String(err));
        this.logger.error("plugins:lifecycle", `Plugin ${name} init failed`, err);
        this.eventBus?.publish("plugin:error" as EventType, { plugin: name, error: String(err) }, { source: "plugin:lifecycle" });
      }
    }
  }

  async startAll(): Promise<void> {
    for (const { loaded, instance } of this.managed) {
      const name = loaded.manifest.name;
      try {
        await instance.start?.();
        this.registry.updateState(name, "started");
        this.eventBus?.publish("plugin:started" as EventType, { plugin: name }, { source: "plugin:lifecycle" });
      } catch (err) {
        this.registry.updateState(name, "error", String(err));
        this.logger.error("plugins:lifecycle", `Plugin ${name} start failed`, err);
        this.eventBus?.publish("plugin:error" as EventType, { plugin: name, error: String(err) }, { source: "plugin:lifecycle" });
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const { loaded, instance } of [...this.managed].reverse()) {
      const name = loaded.manifest.name;
      try {
        await instance.stop?.();
        this.registry.updateState(name, "stopped");
        this.eventBus?.publish("plugin:stopped" as EventType, { plugin: name }, { source: "plugin:lifecycle" });
      } catch (err) {
        this.logger.error("plugins:lifecycle", `Plugin ${name} stop failed`, err);
      }
    }
  }

  async destroyAll(): Promise<void> {
    for (const { loaded, instance } of [...this.managed].reverse()) {
      try {
        await instance.destroy?.();
      } catch (err) {
        this.logger.error("plugins:lifecycle", `Plugin ${loaded.manifest.name} destroy failed`, err);
      }
    }
    this.managed.length = 0;
  }

  private resolvePermissions(requested: readonly PluginPermission[]): PluginPermission[] {
    const allowed = new Set(this.config.allowedPermissions);
    return requested.filter((p) => allowed.has(p)) as PluginPermission[];
  }

  private resolveInstance(loaded: LoadedPlugin): EidolonPlugin {
    const mod = loaded.module;
    // Support both default export and named `plugin` export
    if (mod["default"] && typeof (mod["default"] as EidolonPlugin).init === "function") {
      return mod["default"] as EidolonPlugin;
    }
    if (mod["plugin"] && typeof (mod["plugin"] as EidolonPlugin).init === "function") {
      return mod["plugin"] as EidolonPlugin;
    }
    throw new Error(`Plugin ${loaded.manifest.name} must export 'default' or 'plugin' with an init() method`);
  }
}
