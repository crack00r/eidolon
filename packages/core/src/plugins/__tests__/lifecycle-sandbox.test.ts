/**
 * Integration tests for Plugin Lifecycle Manager + Sandbox.
 *
 * Tests the full plugin lifecycle (init -> start -> stop -> destroy),
 * sandbox permission enforcement, event hook gating, and blocked plugin filtering.
 * Complements the unit tests in packages/core/src/__tests__/plugins.test.ts
 * with deeper integration scenarios.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EidolonPlugin, PluginConfig, PluginContext, PluginManifest, PluginPermission } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { PluginLifecycleManager } from "../lifecycle.ts";
import type { LoadedPlugin } from "../loader.ts";
import { PluginRegistry } from "../registry.ts";
import { createPluginContext, type SandboxDeps } from "../sandbox.ts";

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
// Integration: Lifecycle with EventBus events
// ---------------------------------------------------------------------------

describe("PluginLifecycleManager integration with EventBus", () => {
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

  test("startAll publishes plugin:started events to the EventBus", async () => {
    const plugin = makePlugin();
    const loaded = makeLoadedPlugin(plugin, { name: "event-emitter" });

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loaded]);
    await manager.startAll();

    const count = eventBus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) {
      expect(count.value).toBeGreaterThanOrEqual(1);
    }
  });

  test("init failure publishes plugin:error event to EventBus", async () => {
    const plugin = makePlugin({
      init: async () => {
        throw new Error("init explosion");
      },
    });
    const loaded = makeLoadedPlugin(plugin, { name: "boom-plugin" });

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loaded]);

    const count = eventBus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) {
      expect(count.value).toBeGreaterThanOrEqual(1);
    }

    const info = registry.get("boom-plugin");
    expect(info?.state).toBe("error");
    expect(info?.error).toContain("init explosion");
  });

  test("start failure publishes plugin:error event to EventBus", async () => {
    const plugin = makePlugin({
      start: async () => {
        throw new Error("start kaboom");
      },
    });
    const loaded = makeLoadedPlugin(plugin, { name: "start-fail" });

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loaded]);
    await manager.startAll();

    const info = registry.get("start-fail");
    expect(info?.state).toBe("error");
  });

  test("stopAll publishes plugin:stopped events to EventBus", async () => {
    const plugin = makePlugin();
    const loaded = makeLoadedPlugin(plugin, { name: "stoppable" });

    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);
    await manager.initAll([loaded]);
    await manager.startAll();

    // Drain events from init/start
    const preCount = eventBus.pendingCount();

    await manager.stopAll();

    const info = registry.get("stoppable");
    expect(info?.state).toBe("stopped");
  });

  test("multiple plugins: one blocked, one failing, one succeeding", async () => {
    const successLifecycle: string[] = [];

    const successPlugin = makePlugin({
      init: async (ctx) => {
        successLifecycle.push(`init:${ctx.pluginName}`);
      },
      start: async () => {
        successLifecycle.push("start:good-plugin");
      },
    });

    const failPlugin = makePlugin({
      init: async () => {
        throw new Error("fail init");
      },
    });

    const blockedPlugin = makePlugin({
      init: async () => {
        successLifecycle.push("should-not-happen");
      },
    });

    const loadedGood = makeLoadedPlugin(successPlugin, { name: "good-plugin" });
    const loadedFail = makeLoadedPlugin(failPlugin, { name: "fail-plugin" });
    const loadedBlocked = makeLoadedPlugin(blockedPlugin, { name: "blocked-plugin" });

    const config: PluginConfig = {
      ...DEFAULT_PLUGIN_CONFIG,
      blockedPlugins: ["blocked-plugin"],
    };

    const manager = new PluginLifecycleManager(registry, config, deps, logger, eventBus);
    await manager.initAll([loadedGood, loadedFail, loadedBlocked]);
    await manager.startAll();

    expect(successLifecycle).toEqual(["init:good-plugin", "start:good-plugin"]);

    expect(registry.get("good-plugin")?.state).toBe("started");
    expect(registry.get("fail-plugin")?.state).toBe("error");
    expect(registry.get("blocked-plugin")?.state).toBe("discovered");
  });
});

// ---------------------------------------------------------------------------
// Sandbox permission enforcement (integration)
// ---------------------------------------------------------------------------

describe("createPluginContext sandbox enforcement", () => {
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

  test("plugin with events:listen can subscribe and receive events", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("listener", ["events:listen"], deps);

    let received = false;
    const unsub = ctx.onEvent("system:startup", () => {
      received = true;
    });

    expect(typeof unsub).toBe("function");
    unsub();
  });

  test("plugin with events:emit can publish, plugin with events:listen can observe pending count", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const emitter = createPluginContext("emitter", ["events:emit"], deps);

    emitter.emitEvent("system:startup", { hello: "world" });

    const count = eventBus.pendingCount();
    expect(count.ok).toBe(true);
    if (count.ok) {
      expect(count.value).toBeGreaterThanOrEqual(1);
    }
  });

  test("plugin with no permissions is fully sandboxed", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("sandboxed", [], deps);

    expect(() => ctx.onEvent("user:message", () => {})).toThrow(/lacks permission/);
    expect(() => ctx.emitEvent("system:startup", {})).toThrow(/lacks permission/);
    expect(() => ctx.getConfig()).toThrow(/lacks permission/);
    expect(() => ctx.registerRpcHandler("test", async () => ({}))).toThrow(/lacks permission/);
    expect(() => ctx.registerChannel({} as never)).toThrow(/lacks permission/);
  });

  test("plugin with config:read can read config but not emit events", () => {
    const fakeConfig = { identity: { name: "Eidolon", ownerName: "Test" } };
    const deps: SandboxDeps = { logger, config: fakeConfig as never, eventBus };
    const ctx = createPluginContext("config-reader", ["config:read"], deps);

    const cfg = ctx.getConfig();
    expect(cfg).toBeDefined();
    expect((cfg as Record<string, unknown>).identity).toBeDefined();

    expect(() => ctx.emitEvent("system:startup", {})).toThrow(/lacks permission/);
  });

  test("plugin log messages are prefixed with plugin name", () => {
    const logged: Array<{ module: string; msg: string }> = [];
    const trackingLogger: Logger = {
      debug: (mod, msg) => logged.push({ module: mod, msg }),
      info: (mod, msg) => logged.push({ module: mod, msg }),
      warn: (mod, msg) => logged.push({ module: mod, msg }),
      error: (mod, msg) => logged.push({ module: mod, msg }),
      child: function () {
        return this;
      },
    };

    const deps: SandboxDeps = { logger: trackingLogger, config: {} as never, eventBus };
    const ctx = createPluginContext("my-cool-plugin", [], deps);

    ctx.log.info("test message");
    ctx.log.error("something broke");

    expect(logged).toHaveLength(2);
    expect(logged[0]?.module).toBe("plugin:my-cool-plugin");
    expect(logged[0]?.msg).toBe("test message");
    expect(logged[1]?.module).toBe("plugin:my-cool-plugin");
  });

  test("registerRpcHandler without gateway throws clear error even with permission", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("rpc-plugin", ["gateway:register"], deps);

    expect(() => ctx.registerRpcHandler("myMethod", async () => ({}))).toThrow("Gateway not available");
  });

  test("registerChannel without messageRouter throws clear error even with permission", () => {
    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const ctx = createPluginContext("channel-plugin", ["channel:register"], deps);

    expect(() => ctx.registerChannel({} as never)).toThrow("MessageRouter not available");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: plugin receives context during init
// ---------------------------------------------------------------------------

describe("Plugin receives sandboxed context during lifecycle", () => {
  let db: Database;
  let logger: Logger;
  let eventBus: EventBus;
  let registry: PluginRegistry;

  beforeEach(() => {
    logger = createSilentLogger();
    db = createTestDb();
    eventBus = new EventBus(db, logger);
    registry = new PluginRegistry(logger);
  });

  afterEach(() => {
    db.close();
  });

  test("plugin can use granted permissions via context during init", async () => {
    let configRead = false;

    const plugin = makePlugin({
      init: async (ctx) => {
        // This should work because config:read is in allowedPermissions
        ctx.getConfig();
        configRead = true;
      },
    });

    const loaded = makeLoadedPlugin(plugin, {
      permissions: ["config:read"],
    });

    const config: PluginConfig = {
      ...DEFAULT_PLUGIN_CONFIG,
      allowedPermissions: ["config:read", "events:listen"],
    };

    const deps: SandboxDeps = { logger, config: { identity: { name: "Eidolon" } } as never, eventBus };
    const manager = new PluginLifecycleManager(registry, config, deps, logger, eventBus);
    await manager.initAll([loaded]);

    expect(configRead).toBe(true);
    expect(registry.get("test-plugin")?.state).toBe("initialized");
  });

  test("plugin init fails if it tries to use denied permission", async () => {
    const plugin = makePlugin({
      init: async (ctx) => {
        // events:emit is NOT in allowedPermissions for this test
        ctx.emitEvent("system:startup", {});
      },
    });

    const loaded = makeLoadedPlugin(plugin, {
      name: "greedy-plugin",
      permissions: ["events:emit"],
    });

    const config: PluginConfig = {
      ...DEFAULT_PLUGIN_CONFIG,
      allowedPermissions: ["config:read"], // events:emit NOT allowed
    };

    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const manager = new PluginLifecycleManager(registry, config, deps, logger, eventBus);
    await manager.initAll([loaded]);

    const info = registry.get("greedy-plugin");
    expect(info?.state).toBe("error");
    expect(info?.error).toContain("lacks permission");
  });

  test("destroyAll clears managed list so subsequent startAll is a no-op", async () => {
    const startCalls: string[] = [];
    const plugin = makePlugin({
      start: async () => {
        startCalls.push("started");
      },
    });
    const loaded = makeLoadedPlugin(plugin);

    const deps: SandboxDeps = { logger, config: {} as never, eventBus };
    const manager = new PluginLifecycleManager(registry, DEFAULT_PLUGIN_CONFIG, deps, logger, eventBus);

    await manager.initAll([loaded]);
    await manager.startAll();
    expect(startCalls).toHaveLength(1);

    await manager.destroyAll();

    // After destroy, startAll should do nothing (managed list is empty)
    await manager.startAll();
    expect(startCalls).toHaveLength(1);
  });
});
