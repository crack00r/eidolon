/**
 * Tests for HAPolicyChecker.
 *
 * Verifies domain-level security classification (safe / needs_approval / dangerous),
 * entity-level exceptions, unknown domain fallback, and integration with HAManager
 * service execution flow.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { HomeAutomationConfig } from "@eidolon/protocol";
import { ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { EventBus } from "../../loop/event-bus.ts";
import { HAManager } from "../manager.ts";
import { HAPolicyChecker } from "../policies.ts";

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
  db.exec(`
    CREATE TABLE ha_entities (
      entity_id TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      friendly_name TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'unknown',
      attributes TEXT NOT NULL DEFAULT '{}',
      last_changed INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE ha_scenes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      actions TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      last_executed_at INTEGER
    );
  `);
  return db;
}

function createMockEventBus(): EventBus & { readonly published: Array<{ type: string; payload: unknown }> } {
  const published: Array<{ type: string; payload: unknown }> = [];
  return {
    published,
    publish(type: string, payload: unknown) {
      published.push({ type, payload });
      return Ok({
        id: "evt-1",
        type,
        priority: "normal" as const,
        payload,
        timestamp: Date.now(),
        source: "test",
      });
    },
    subscribe: () => () => {},
    subscribeAll: () => () => {},
    dequeue: () => Ok(null),
    pendingCount: () => Ok(0),
    markProcessed: () => Ok(undefined),
    replayUnprocessed: () => Ok([]),
    pause: () => {},
    resume: () => {},
  } as unknown as EventBus & { readonly published: Array<{ type: string; payload: unknown }> };
}

function makeConfig(overrides?: Partial<HomeAutomationConfig>): HomeAutomationConfig {
  return {
    enabled: true,
    syncIntervalMinutes: 5,
    domainPolicies: [
      { domain: "light", level: "safe" },
      { domain: "switch", level: "safe" },
      { domain: "sensor", level: "safe" },
      { domain: "lock", level: "needs_approval" },
      { domain: "alarm_control_panel", level: "dangerous" },
      { domain: "climate", level: "needs_approval" },
      { domain: "cover", level: "safe" },
      { domain: "media_player", level: "safe" },
      { domain: "fan", level: "safe" },
      { domain: "camera", level: "needs_approval" },
    ],
    anomalyDetection: {
      enabled: false,
      rules: [],
    },
    scenes: [],
    ...overrides,
  };
}

const logger = createSilentLogger();

// ---------------------------------------------------------------------------
// HAPolicyChecker unit tests
// ---------------------------------------------------------------------------

describe("HAPolicyChecker", () => {
  describe("lights and switches are classified as safe", () => {
    const checker = new HAPolicyChecker(makeConfig(), logger);

    test("light domain is safe", () => {
      const result = checker.checkPolicy("light", "light.living_room");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("safe");
        expect(result.value.domain).toBe("light");
      }
    });

    test("switch domain is safe", () => {
      const result = checker.checkPolicy("switch", "switch.garden_pump");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("safe");
      }
    });

    test("fan domain is safe", () => {
      const result = checker.checkPolicy("fan", "fan.bedroom");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("safe");
      }
    });

    test("cover domain is safe", () => {
      const result = checker.checkPolicy("cover", "cover.garage_door");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("safe");
      }
    });

    test("media_player domain is safe", () => {
      const result = checker.checkPolicy("media_player", "media_player.sonos");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("safe");
      }
    });

    test("sensor domain is safe (read-only)", () => {
      const result = checker.checkPolicy("sensor", "sensor.temperature_kitchen");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("safe");
      }
    });
  });

  describe("locks and cameras are classified as needs_approval", () => {
    const checker = new HAPolicyChecker(makeConfig(), logger);

    test("lock domain needs approval", () => {
      const result = checker.checkPolicy("lock", "lock.front_door");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("needs_approval");
        expect(result.value.domain).toBe("lock");
      }
    });

    test("climate domain needs approval", () => {
      const result = checker.checkPolicy("climate", "climate.hvac");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("needs_approval");
      }
    });

    test("camera domain needs approval", () => {
      const result = checker.checkPolicy("camera", "camera.front_porch");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("needs_approval");
      }
    });
  });

  describe("alarm_control_panel is classified as dangerous", () => {
    const checker = new HAPolicyChecker(makeConfig(), logger);

    test("alarm_control_panel domain is dangerous", () => {
      const result = checker.checkPolicy("alarm_control_panel", "alarm_control_panel.home");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("dangerous");
        expect(result.value.domain).toBe("alarm_control_panel");
      }
    });

    test("alarm_control_panel without entity ID is dangerous", () => {
      const result = checker.checkPolicy("alarm_control_panel");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("dangerous");
      }
    });
  });

  describe("unknown entities default to needs_approval", () => {
    const checker = new HAPolicyChecker(makeConfig(), logger);

    test("unknown domain defaults to needs_approval", () => {
      const result = checker.checkPolicy("water_heater", "water_heater.main");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("needs_approval");
        expect(result.value.reason).toContain("Unknown domain");
      }
    });

    test("another unknown domain defaults to needs_approval", () => {
      const result = checker.checkPolicy("siren", "siren.alarm");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("needs_approval");
      }
    });

    test("empty string domain defaults to needs_approval", () => {
      const result = checker.checkPolicy("", "");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("needs_approval");
      }
    });
  });

  describe("entity-level exceptions override domain policy", () => {
    test("entity exception overrides domain-level safe to dangerous", () => {
      const config = makeConfig({
        domainPolicies: [
          {
            domain: "light",
            level: "safe",
            exceptions: {
              "light.server_room": "dangerous",
            },
          },
        ],
      });
      const checker = new HAPolicyChecker(config, logger);

      // Regular light is safe
      const regularResult = checker.checkPolicy("light", "light.living_room");
      expect(regularResult.ok).toBe(true);
      if (regularResult.ok) {
        expect(regularResult.value.level).toBe("safe");
      }

      // Server room light has an exception -> dangerous
      const serverResult = checker.checkPolicy("light", "light.server_room");
      expect(serverResult.ok).toBe(true);
      if (serverResult.ok) {
        expect(serverResult.value.level).toBe("dangerous");
        expect(serverResult.value.reason).toContain("Entity exception");
      }
    });

    test("entity exception overrides domain-level dangerous to safe", () => {
      const config = makeConfig({
        domainPolicies: [
          {
            domain: "alarm_control_panel",
            level: "dangerous",
            exceptions: {
              "alarm_control_panel.test_panel": "safe",
            },
          },
        ],
      });
      const checker = new HAPolicyChecker(config, logger);

      // Test panel has exception -> safe
      const testResult = checker.checkPolicy("alarm_control_panel", "alarm_control_panel.test_panel");
      expect(testResult.ok).toBe(true);
      if (testResult.ok) {
        expect(testResult.value.level).toBe("safe");
      }

      // Regular alarm panel stays dangerous (from defaults)
      const regularResult = checker.checkPolicy("alarm_control_panel", "alarm_control_panel.home");
      expect(regularResult.ok).toBe(true);
      if (regularResult.ok) {
        expect(regularResult.value.level).toBe("dangerous");
      }
    });

    test("entity exception to needs_approval", () => {
      const config = makeConfig({
        domainPolicies: [
          {
            domain: "switch",
            level: "safe",
            exceptions: {
              "switch.main_breaker": "needs_approval",
            },
          },
        ],
      });
      const checker = new HAPolicyChecker(config, logger);

      const result = checker.checkPolicy("switch", "switch.main_breaker");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("needs_approval");
      }
    });

    test("no entity exception applied when entity does not match", () => {
      const config = makeConfig({
        domainPolicies: [
          {
            domain: "light",
            level: "safe",
            exceptions: {
              "light.server_room": "dangerous",
            },
          },
        ],
      });
      const checker = new HAPolicyChecker(config, logger);

      // A different light entity should still get the domain-level safe
      const result = checker.checkPolicy("light", "light.kitchen");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("safe");
      }
    });

    test("no exception applied when no entityId is provided", () => {
      const config = makeConfig({
        domainPolicies: [
          {
            domain: "light",
            level: "safe",
            exceptions: {
              "light.server_room": "dangerous",
            },
          },
        ],
      });
      const checker = new HAPolicyChecker(config, logger);

      // Domain check without entity ID -- falls through to domain level
      const result = checker.checkPolicy("light");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("safe");
      }
    });
  });

  describe("user-configured custom policies override defaults", () => {
    test("user can make a normally-safe domain require approval", () => {
      const config = makeConfig({
        domainPolicies: [
          { domain: "light", level: "needs_approval" }, // override default "safe"
        ],
      });
      const checker = new HAPolicyChecker(config, logger);

      const result = checker.checkPolicy("light", "light.living_room");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("needs_approval");
      }
    });

    test("user can make lock domain safe (relaxed policy)", () => {
      const config = makeConfig({
        domainPolicies: [
          { domain: "lock", level: "safe" }, // override default "needs_approval"
        ],
      });
      const checker = new HAPolicyChecker(config, logger);

      const result = checker.checkPolicy("lock", "lock.front_door");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.level).toBe("safe");
      }
    });

    test("user config policies are merged with built-in defaults for missing domains", () => {
      const config = makeConfig({
        domainPolicies: [
          { domain: "light", level: "needs_approval" }, // custom override
          // switch, lock, alarm_control_panel, etc. not specified -- defaults apply
        ],
      });
      const checker = new HAPolicyChecker(config, logger);

      // light: user override
      const lightResult = checker.checkPolicy("light");
      expect(lightResult.ok).toBe(true);
      if (lightResult.ok) expect(lightResult.value.level).toBe("needs_approval");

      // switch: default (safe)
      const switchResult = checker.checkPolicy("switch");
      expect(switchResult.ok).toBe(true);
      if (switchResult.ok) expect(switchResult.value.level).toBe("safe");

      // alarm_control_panel: default (dangerous)
      const alarmResult = checker.checkPolicy("alarm_control_panel");
      expect(alarmResult.ok).toBe(true);
      if (alarmResult.ok) expect(alarmResult.value.level).toBe("dangerous");
    });
  });

  describe("listPolicies and getDomainPolicy", () => {
    const checker = new HAPolicyChecker(makeConfig(), logger);

    test("listPolicies returns all configured + default policies", () => {
      const policies = checker.listPolicies();
      expect(policies.length).toBeGreaterThan(0);

      // Should include domains from config and defaults
      const domains = policies.map((p) => p.domain);
      expect(domains).toContain("light");
      expect(domains).toContain("lock");
      expect(domains).toContain("alarm_control_panel");
    });

    test("getDomainPolicy returns policy for known domain", () => {
      const policy = checker.getDomainPolicy("light");
      expect(policy).not.toBeNull();
      expect(policy?.level).toBe("safe");
    });

    test("getDomainPolicy returns null for unknown domain", () => {
      const policy = checker.getDomainPolicy("nonexistent_domain");
      expect(policy).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// HAManager service execution integration tests
// ---------------------------------------------------------------------------

describe("HAManager service execution with policy enforcement", () => {
  const databases: Database[] = [];

  function makeDb(): Database {
    const db = createTestDb();
    databases.push(db);
    return db;
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  test("safe actions execute immediately without approval", async () => {
    const db = makeDb();
    const eventBus = createMockEventBus();
    const manager = new HAManager({
      db,
      logger,
      eventBus,
      config: makeConfig(),
    });

    // Light is safe -- should execute without approval
    const result = await manager.executeService("light.living_room", "light", "turn_on");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
      expect(result.value.entityId).toBe("light.living_room");
      expect(result.value.service).toBe("turn_on");
    }
  });

  test("safe switch actions execute immediately", async () => {
    const db = makeDb();
    const eventBus = createMockEventBus();
    const manager = new HAManager({
      db,
      logger,
      eventBus,
      config: makeConfig(),
    });

    const result = await manager.executeService("switch.garden_pump", "switch", "toggle");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.success).toBe(true);
    }
  });

  test("dangerous actions are denied by policy", async () => {
    const db = makeDb();
    const eventBus = createMockEventBus();
    const manager = new HAManager({
      db,
      logger,
      eventBus,
      config: makeConfig(),
    });

    // Alarm panel is dangerous -- should be denied
    const result = await manager.executeService("alarm_control_panel.home", "alarm_control_panel", "arm_away");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.HA_POLICY_DENIED);
      expect(result.error.message).toContain("denied by policy");
    }
  });

  test("needs_approval actions pass policy check but proceed (executor decides)", async () => {
    const db = makeDb();
    const eventBus = createMockEventBus();
    const manager = new HAManager({
      db,
      logger,
      eventBus,
      config: makeConfig(),
    });

    // Lock needs approval -- executeService now blocks needs_approval actions
    const result = await manager.executeService("lock.front_door", "lock", "lock");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.HA_POLICY_DENIED);
    }
  });

  test("custom executor function is called for safe actions", async () => {
    const db = makeDb();
    const eventBus = createMockEventBus();
    const manager = new HAManager({
      db,
      logger,
      eventBus,
      config: makeConfig(),
    });

    let executorCalled = false;
    const mockExecutor = async (entityId: string, domain: string, service: string) => {
      executorCalled = true;
      return Ok({
        entityId,
        domain,
        service,
        success: true,
      });
    };

    const result = await manager.executeService("light.kitchen", "light", "turn_off", undefined, mockExecutor);

    expect(result.ok).toBe(true);
    expect(executorCalled).toBe(true);
  });

  test("custom executor is NOT called for dangerous actions (blocked by policy)", async () => {
    const db = makeDb();
    const eventBus = createMockEventBus();
    const manager = new HAManager({
      db,
      logger,
      eventBus,
      config: makeConfig(),
    });

    let executorCalled = false;
    const mockExecutor = async (entityId: string, domain: string, service: string) => {
      executorCalled = true;
      return Ok({
        entityId,
        domain,
        service,
        success: true,
      });
    };

    const result = await manager.executeService(
      "alarm_control_panel.home",
      "alarm_control_panel",
      "disarm",
      undefined,
      mockExecutor,
    );

    expect(result.ok).toBe(false);
    expect(executorCalled).toBe(false); // Executor never reached
  });

  test("entity exception affects service execution", async () => {
    const db = makeDb();
    const eventBus = createMockEventBus();
    const config = makeConfig({
      domainPolicies: [
        {
          domain: "light",
          level: "safe",
          exceptions: {
            "light.server_room": "dangerous",
          },
        },
      ],
    });
    const manager = new HAManager({
      db,
      logger,
      eventBus,
      config,
    });

    // Regular light: safe -> executes
    const regularResult = await manager.executeService("light.kitchen", "light", "turn_on");
    expect(regularResult.ok).toBe(true);

    // Server room light: exception -> dangerous -> denied
    const serverResult = await manager.executeService("light.server_room", "light", "turn_off");
    expect(serverResult.ok).toBe(false);
    if (!serverResult.ok) {
      expect(serverResult.error.code).toBe(ErrorCode.HA_POLICY_DENIED);
    }
  });

  test("unknown domain in service execution defaults to needs_approval (not blocked)", async () => {
    const db = makeDb();
    const eventBus = createMockEventBus();
    const manager = new HAManager({
      db,
      logger,
      eventBus,
      config: makeConfig(),
    });

    // Unknown domain -- defaults to needs_approval, which is now blocked by executeService
    const result = await manager.executeService("water_heater.main", "water_heater", "turn_on");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(ErrorCode.HA_POLICY_DENIED);
    }
  });
});
