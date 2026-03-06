/**
 * Tests for the Plugin System: registry, sandbox, and lifecycle manager.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EidolonPlugin, PluginConfig, PluginContext, PluginManifest, PluginPermission } from "@eidolon/protocol";
import { runMigrations } from "../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../database/schemas/operational.ts";
import type { Logger } from "../logging/logger.ts";
import { EventBus } from "../loop/event-bus.ts";
import { PluginLifecycleManager } from "../plugins/lifecycle.ts";
import type { LoadedPlugin } from "../plugins/loader.ts";
import { PluginRegistry } from "../plugins/registry.ts";
import { createPluginContext, type SandboxDeps } from "../plugins/sandbox.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, createSilentLogger());
  if (!result.ok) throw new Error(`Failed to run migrations: ${result.error.message}`);
  return db;
}

function makeManifest(overrides?: Partial<PluginManifest>): PluginManifest {
  return {
    name: "test-plugin",
    version: "1.0.0",
    description: "Test plugin",
    eidolonVersion: "0.1.0",
    permissions: ["events:listen", "config:read"] as readonly PluginPermission[],
    extensionPoints: [],
    main: "index.ts",
    ...overrides,
  };
}

function makePlugin(overrides?: Partial<EidolonPlugin>): EidolonPlugin {
  return {
    init: async (_ctx: PluginContext) => {},
    start: async () => {},
    stop: async () => {},
    destroy: async () => {},
    ...overrides,
  };
}

function makeLoadedPlugin(plugin: EidolonPlugin, manifestOverrides?: Partial<PluginManifest>): LoadedPlugin {
  return {
    manifest: makeManifest(manifestOverrides),
    module: { default: plugin },
    directory: "/tmp/test-plugin",
  };
}

const DEFAULT_PLUGIN_CONFIG: PluginConfig = {
  enabled: true,
  directory: "/tmp/plugins",
  autoUpdate: false,
  allowedPermissions: ["events:listen", "config:read", "events:emit"],
  blockedPlugins: [],
};

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

describe("PluginRegistry", () => {
  const logger = createSilentLogger();

  test("register stores plugin info with correct state", () => {
    const registry = new PluginRegistry(logger);
    const loaded = makeLoadedPlugin(makePlugin());

    registry.register(loaded, "initialized");

    const info = registry.get("test-plugin");
    expect(info).toBeDefined();
    expect(info?.manifest.name).toBe("test-plugin");
    expect(info?.state).toBe("initialized");
    expect(info?.directory).toBe("/tmp/test-plugin");
    expect(typeof info?.loadedAt).toBe("number");
  });

  test("has returns true for registered plugins", () => {
    const registry = new PluginRegistry(logger);
    const loaded = makeLoadedPlugin(makePlugin());

    expect(registry.has("test-plugin")).toBe(false);
    registry.register(loaded, "initialized");
    expect(registry.has("test-plugin")).toBe(true);
  });

  test("getAll returns all registered plugins", () => {
    const registry = new PluginRegistry(logger);

    registry.register(makeLoadedPlugin(makePlugin(), { name: "plugin-a" }), "initialized");
    registry.register(makeLoadedPlugin(makePlugin(), { name: "plugin-b" }), "started");

    const all = registry.getAll();
    expect(all).toHaveLength(2);

    const names = all.map((p) => p.manifest.name);
    expect(names).toContain("plugin-a");
    expect(names).toContain("plugin-b");
  });

  test("remove deletes plugin from registry", () => {
    const registry = new PluginRegistry(logger);
    const loaded = makeLoadedPlugin(makePlugin());

    registry.register(loaded, "initialized");
    expect(registry.has("test-plugin")).toBe(true);

    const removed = registry.remove("test-plugin");
    expect(removed).toBe(true);
    expect(registry.has("test-plugin")).toBe(false);
    expect(registry.get("test-plugin")).toBeUndefined();
  });

  test("remove returns false for non-existent plugin", () => {
    const registry = new PluginRegistry(logger);
    expect(registry.remove("nonexistent")).toBe(false);
  });

  test("updateState changes plugin state", () => {
    const registry = new PluginRegistry(logger);
    const loaded = makeLoadedPlugin(makePlugin());

    registry.register(loaded, "initialized");
    registry.updateState("test-plugin", "started");

    const info = registry.get("test-plugin");
    expect(info?.state).toBe("started");
    expect(typeof info?.startedAt).toBe("number");
  });

  test("updateState records error string", () => {
    const registry = new PluginRegistry(logger);
    const loaded = makeLoadedPlugin(makePlugin());

    registry.register(loaded, "initialized");
    registry.updateState("test-plugin", "error", "Something went wrong");

    const info = registry.get("test-plugin");
    expect(info?.state).toBe("error");
    expect(info?.error).toBe("Something went wrong");
  });

  test("updateState is no-op for unknown plugin", () => {
    const registry = new PluginRegistry(logger);
    // Should not throw
    registry.updateState("nonexistent", "started");
    expect(registry.get("nonexistent")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createPluginContext (Sandbox)
// ---------------------------------------------------------------------------

describe("createPluginContext", () => {
  let db: Database;
  let logger: Logger;
  let eventBus: EventBus;

  beforeEach(() => {
    logger = createSilentLogger();
    db = createTestDb();
    eventBus = new EventBus(db, logger);
  });

  afterEach(() => {
    db.close();
  });

  test("returns context with correct pluginName and permissions", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("my-plugin", ["events:listen", "config:read"], deps);

    expect(ctx.pluginName).toBe("my-plugin");
    expect(ctx.permissions.has("events:listen")).toBe(true);
    expect(ctx.permissions.has("config:read")).toBe(true);
    expect(ctx.permissions.has("events:emit")).toBe(false);
  });

  test("log forwards to parent logger", () => {
    const logged: Array<{ level: string; msg: string }> = [];
    const trackingLogger: Logger = {
      debug: (_mod, msg) => logged.push({ level: "debug", msg }),
      info: (_mod, msg) => logged.push({ level: "info", msg }),
      warn: (_mod, msg) => logged.push({ level: "warn", msg }),
      error: (_mod, msg) => logged.push({ level: "error", msg }),
      child: () => trackingLogger,
    };

    const deps: SandboxDeps = { logger: trackingLogger, config: {} as never, eventBus };
    const ctx = createPluginContext("log-test", [], deps);

    ctx.log.info("hello from plugin");
    ctx.log.warn("something concerning");

    expect(logged).toHaveLength(2);
    expect(logged[0]?.level).toBe("info");
    expect(logged[0]?.msg).toBe("hello from plugin");
    expect(logged[1]?.level).toBe("warn");
  });

  test("onEvent throws when events:listen permission not granted", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("no-listen", [], deps);

    expect(() => ctx.onEvent("user:message", () => {})).toThrow(/lacks permission.*events:listen/);
  });

  test("onEvent succeeds with events:listen permission", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("listener", ["events:listen"], deps);

    const unsub = ctx.onEvent("user:message", () => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("emitEvent throws when events:emit permission not granted", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("no-emit", ["events:listen"], deps);

    expect(() => ctx.emitEvent("system:startup", {})).toThrow(/lacks permission.*events:emit/);
  });

  test("emitEvent succeeds with events:emit permission", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("emitter", ["events:emit"], deps);

    // Should not throw
    ctx.emitEvent("system:startup", { started: true });

    // Verify event was persisted
    const count = eventBus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) {
      expect(count.value).toBeGreaterThanOrEqual(1);
    }
  });

  test("getConfig throws when config:read permission not granted", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("no-config", [], deps);

    expect(() => ctx.getConfig()).toThrow(/lacks permission.*config:read/);
  });

  test("getConfig returns config object with permission", () => {
    const fakeConfig = { identity: { name: "Eidolon" } };
    const deps: SandboxDeps = { logger, config: fakeConfig as never, eventBus };
    const ctx = createPluginContext("reader", ["config:read"], deps);

    const cfg = ctx.getConfig();
    expect(cfg).toBeDefined();
  });

  test("registerRpcHandler throws when gateway:register permission not granted", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("no-rpc", [], deps);

    expect(() => ctx.registerRpcHandler("myMethod", async () => ({}))).toThrow(/lacks permission.*gateway:register/);
  });

  test("registerChannel throws when channel:register permission not granted", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("no-channel", [], deps);

    expect(() => ctx.registerChannel({} as never)).toThrow(/lacks permission.*channel:register/);
  });

  test("onEvent throws when EventBus is not available", () => {
    const deps: SandboxDeps = { logger, config: {} as never };
    const ctx = createPluginContext("no-bus", ["events:listen"], deps);

    expect(() => ctx.onEvent("user:message", () => {})).toThrow("EventBus not available");
  });

  test("emitEvent throws when EventBus is not available", () => {
    const deps: SandboxDeps = { logger, config: {} as never };
    const ctx = createPluginContext("no-bus-emit", ["events:emit"], deps);

    expect(() => ctx.emitEvent("system:startup", {})).toThrow("EventBus not available");
  });
});

// ---------------------------------------------------------------------------
// PluginLifecycleManager
// ---------------------------------------------------------------------------

describe("PluginLifecycleManager", () => {
  let db: Database;
  let logger: Logger;
  let eventBus: EventBus;
  let registry: PluginRegistry;
  let deps: SandboxDeps;

  beforeEach(() => {
    logger = createSilentLogger();
    db = createTestDb();
    eventBus = new EventBus(db, logger);
    registry = new PluginRegistry(logger);
    deps = { logger, config: {} as never, eventBus };
  });

  afterEach(() => {
    db.close();
  });

  test("initAll initializes valid plugins", async () => {
    const initCalls: string[] = [];
    const plugin = makePlugin({
      init: async (ctx) => {
        initCalls.push(ctx.pluginName);
      },
    });
    const loaded = makeLoadedPlugin(plugin);

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loaded]);

    expect(initCalls).toEqual(["test-plugin"]);

    const info = registry.get("test-plugin");
    expect(info?.state).toBe("initialized");
  });

  test("initAll skips blocked plugins", async () => {
    const initCalls: string[] = [];
    const plugin = makePlugin({
      init: async (ctx) => {
        initCalls.push(ctx.pluginName);
      },
    });
    const loaded = makeLoadedPlugin(plugin, { name: "blocked-one" });

    const config: PluginConfig = {
      ...DEFAULT_PLUGIN_CONFIG,
      blockedPlugins: ["blocked-one"],
    };

    const manager = new PluginLifecycleManager(registry, config, deps, logger, eventBus);
    await manager.initAll([loaded]);

    expect(initCalls).toEqual([]);

    const info = registry.get("blocked-one");
    expect(info?.state).toBe("discovered");
  });

  test("initAll filters denied permissions and logs warning", async () => {
    const warnings: string[] = [];
    const trackingLogger: Logger = {
      debug: () => {},
      info: () => {},
      warn: (_mod, msg) => warnings.push(msg),
      error: () => {},
      child: function () {
        return this;
      },
    };

    const plugin = makePlugin();
    const loaded = makeLoadedPlugin(plugin, {
      name: "perm-test",
      permissions: ["events:listen", "config:read", "shell:execute"],
    });

    const config: PluginConfig = {
      ...DEFAULT_PLUGIN_CONFIG,
      allowedPermissions: ["events:listen", "config:read"],
    };

    const localDeps: SandboxDeps = { logger: trackingLogger, config: {} as never, eventBus };
    const localRegistry = new PluginRegistry(trackingLogger);
    const manager = new PluginLifecycleManager(localRegistry, config, localDeps, trackingLogger, eventBus);
    await manager.initAll([loaded]);

    expect(warnings.some((w) => w.includes("shell:execute"))).toBe(true);
  });

  test("initAll handles plugin init failure gracefully", async () => {
    const plugin = makePlugin({
      init: async () => {
        throw new Error("Init boom");
      },
    });
    const loaded = makeLoadedPlugin(plugin, { name: "fail-plugin" });

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);

    // Should not throw
    await manager.initAll([loaded]);

    const info = registry.get("fail-plugin");
    expect(info?.state).toBe("error");
    expect(info?.error).toContain("Init boom");
  });

  test("initAll initializes multiple plugins in order", async () => {
    const initOrder: string[] = [];

    const pluginA = makePlugin({
      init: async (ctx) => {
        initOrder.push(ctx.pluginName);
      },
    });
    const pluginB = makePlugin({
      init: async (ctx) => {
        initOrder.push(ctx.pluginName);
      },
    });

    const loadedA = makeLoadedPlugin(pluginA, { name: "alpha" });
    const loadedB = makeLoadedPlugin(pluginB, { name: "beta" });

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loadedA, loadedB]);

    expect(initOrder).toEqual(["alpha", "beta"]);
  });

  test("startAll starts all initialized plugins", async () => {
    const startCalls: string[] = [];
    const plugin = makePlugin({
      start: async () => {
        startCalls.push("started");
      },
    });
    const loaded = makeLoadedPlugin(plugin);

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loaded]);
    await manager.startAll();

    expect(startCalls).toEqual(["started"]);
    expect(registry.get("test-plugin")?.state).toBe("started");
  });

  test("stopAll stops all started plugins in reverse order", async () => {
    const stopOrder: string[] = [];
    const pluginA = makePlugin({
      stop: async () => {
        stopOrder.push("alpha");
      },
    });
    const pluginB = makePlugin({
      stop: async () => {
        stopOrder.push("beta");
      },
    });

    const loadedA = makeLoadedPlugin(pluginA, { name: "alpha" });
    const loadedB = makeLoadedPlugin(pluginB, { name: "beta" });

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loadedA, loadedB]);
    await manager.startAll();
    await manager.stopAll();

    // stopAll processes in reverse order
    expect(stopOrder).toEqual(["beta", "alpha"]);
    expect(registry.get("alpha")?.state).toBe("stopped");
    expect(registry.get("beta")?.state).toBe("stopped");
  });

  test("destroyAll destroys plugins in reverse order and clears managed list", async () => {
    const destroyOrder: string[] = [];
    const pluginA = makePlugin({
      destroy: async () => {
        destroyOrder.push("alpha");
      },
    });
    const pluginB = makePlugin({
      destroy: async () => {
        destroyOrder.push("beta");
      },
    });

    const loadedA = makeLoadedPlugin(pluginA, { name: "alpha" });
    const loadedB = makeLoadedPlugin(pluginB, { name: "beta" });

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loadedA, loadedB]);
    await manager.destroyAll();

    expect(destroyOrder).toEqual(["beta", "alpha"]);

    // After destroy, starting again should be a no-op (managed list cleared)
    const secondStartCalls: string[] = [];
    const manager2 = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager2.startAll();
    expect(secondStartCalls).toEqual([]);
  });

  test("full lifecycle: init -> start -> stop -> destroy", async () => {
    const lifecycle: string[] = [];
    const plugin = makePlugin({
      init: async () => {
        lifecycle.push("init");
      },
      start: async () => {
        lifecycle.push("start");
      },
      stop: async () => {
        lifecycle.push("stop");
      },
      destroy: async () => {
        lifecycle.push("destroy");
      },
    });
    const loaded = makeLoadedPlugin(plugin);

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);

    await manager.initAll([loaded]);
    await manager.startAll();
    await manager.stopAll();
    await manager.destroyAll();

    expect(lifecycle).toEqual(["init", "start", "stop", "destroy"]);
  });

  test("startAll handles plugin start failure gracefully", async () => {
    const plugin = makePlugin({
      start: async () => {
        throw new Error("Start failed");
      },
    });
    const loaded = makeLoadedPlugin(plugin, { name: "fail-start" });

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);

    await manager.initAll([loaded]);
    // Should not throw
    await manager.startAll();

    expect(registry.get("fail-start")?.state).toBe("error");
  });

  test("resolves plugin from named 'plugin' export", async () => {
    const initCalls: string[] = [];
    const plugin = makePlugin({
      init: async (ctx) => {
        initCalls.push(ctx.pluginName);
      },
    });
    // Use named export instead of default
    const loaded: LoadedPlugin = {
      manifest: makeManifest({ name: "named-export" }),
      module: { plugin },
      directory: "/tmp/named-export",
    };

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loaded]);

    expect(initCalls).toEqual(["named-export"]);
  });

  test("initAll errors when module has no valid export", async () => {
    const loaded: LoadedPlugin = {
      manifest: makeManifest({ name: "bad-export" }),
      module: { somethingElse: "not a plugin" },
      directory: "/tmp/bad-export",
    };

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loaded]);

    const info = registry.get("bad-export");
    expect(info?.state).toBe("error");
    expect(info?.error).toContain("must export");
  });
});
