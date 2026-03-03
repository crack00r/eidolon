/**
 * Tests for HAManager.
 *
 * Verifies entity sync with state change detection, anomaly detection,
 * policy enforcement, context injection, and service execution.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { HAEntity, HomeAutomationConfig } from "@eidolon/protocol";
import { ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { EventBus } from "../../loop/event-bus.ts";
import { HAManager } from "../manager.ts";

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
      { domain: "lock", level: "needs_approval" },
      { domain: "alarm_control_panel", level: "dangerous" },
    ],
    anomalyDetection: {
      enabled: true,
      rules: [],
    },
    scenes: [],
    ...overrides,
  };
}

function makeEntity(overrides?: Partial<HAEntity>): HAEntity {
  return {
    entityId: "light.living_room",
    domain: "light",
    friendlyName: "Living Room Light",
    state: "on",
    attributes: {},
    lastChanged: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HAManager", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeDeps(configOverrides?: Partial<HomeAutomationConfig>): {
    db: Database;
    eventBus: ReturnType<typeof createMockEventBus>;
    config: HomeAutomationConfig;
  } {
    const db = createTestDb();
    databases.push(db);
    return {
      db,
      eventBus: createMockEventBus(),
      config: makeConfig(configOverrides),
    };
  }

  afterEach(() => {
    for (const db of databases) {
      db.close();
    }
    databases.length = 0;
  });

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  describe("initialize", () => {
    test("initializes successfully when enabled", async () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      const result = await manager.initialize();
      expect(result.ok).toBe(true);

      await manager.dispose();
    });

    test("skips initialization when disabled", async () => {
      const deps = makeDeps({ enabled: false });
      const manager = new HAManager({ ...deps, logger });

      const result = await manager.initialize();
      expect(result.ok).toBe(true);

      await manager.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // Entity sync
  // -------------------------------------------------------------------------

  describe("syncEntities", () => {
    test("upserts entities into the cache", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      const entities = [
        makeEntity({ entityId: "light.kitchen", friendlyName: "Kitchen Light" }),
        makeEntity({ entityId: "light.bedroom", friendlyName: "Bedroom Light" }),
      ];

      const result = manager.syncEntities(entities);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(2);

      // Verify entities are in cache
      const listResult = manager.listEntities();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value.length).toBe(2);
    });

    test("detects state changes and publishes events", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      // Initial sync
      manager.syncEntities([makeEntity({ entityId: "light.kitchen", state: "on" })]);

      // State change
      manager.syncEntities([makeEntity({ entityId: "light.kitchen", state: "off" })]);

      const stateChanges = deps.eventBus.published.filter((e) => e.type === "ha:state_changed");
      expect(stateChanges.length).toBe(1);
      const payload = stateChanges[0]?.payload as { oldState: string; newState: string };
      expect(payload.oldState).toBe("on");
      expect(payload.newState).toBe("off");
    });

    test("does not publish event when state unchanged", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      const entity = makeEntity({ entityId: "light.kitchen", state: "on" });
      manager.syncEntities([entity]);
      manager.syncEntities([entity]);

      const stateChanges = deps.eventBus.published.filter((e) => e.type === "ha:state_changed");
      expect(stateChanges.length).toBe(0);
    });

    test("updates existing entities on re-sync", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([makeEntity({ entityId: "light.kitchen", friendlyName: "Old Name" })]);
      manager.syncEntities([makeEntity({ entityId: "light.kitchen", friendlyName: "New Name" })]);

      const getResult = manager.getEntity("light.kitchen");
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;
      expect(getResult.value?.friendlyName).toBe("New Name");
    });
  });

  // -------------------------------------------------------------------------
  // listEntities / getEntity
  // -------------------------------------------------------------------------

  describe("listEntities", () => {
    test("filters entities by domain", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([
        makeEntity({ entityId: "light.kitchen", domain: "light" }),
        makeEntity({ entityId: "switch.kitchen", domain: "switch" }),
        makeEntity({ entityId: "light.bedroom", domain: "light" }),
      ]);

      const result = manager.listEntities("light");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });

    test("returns all entities when no domain filter", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([
        makeEntity({ entityId: "light.kitchen", domain: "light" }),
        makeEntity({ entityId: "switch.kitchen", domain: "switch" }),
      ]);

      const result = manager.listEntities();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });
  });

  describe("getEntity", () => {
    test("returns entity by ID", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([makeEntity({ entityId: "light.kitchen", friendlyName: "Kitchen Light" })]);

      const result = manager.getEntity("light.kitchen");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.friendlyName).toBe("Kitchen Light");
    });

    test("returns null for nonexistent entity", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      const result = manager.getEntity("nonexistent");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // executeService
  // -------------------------------------------------------------------------

  describe("executeService", () => {
    test("allows safe domain actions", async () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      const result = await manager.executeService("light.kitchen", "light", "turn_on");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.success).toBe(true);
    });

    test("blocks dangerous domain actions", async () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      const result = await manager.executeService("alarm.home", "alarm_control_panel", "arm_away");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCode.HA_POLICY_DENIED);
    });

    test("delegates to executor function when provided", async () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      let executorCalled = false;
      const result = await manager.executeService(
        "light.kitchen",
        "light",
        "turn_on",
        { brightness: 128 },
        async (entityId, domain, service, data) => {
          executorCalled = true;
          return Ok({ entityId, domain, service, success: true });
        },
      );

      expect(result.ok).toBe(true);
      expect(executorCalled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Anomaly detection
  // -------------------------------------------------------------------------

  describe("checkAnomalies", () => {
    test("detects anomalies matching entity pattern and condition", () => {
      const deps = makeDeps({
        anomalyDetection: {
          enabled: true,
          rules: [
            {
              entityPattern: "light.*",
              condition: "state == on",
              message: "{friendlyName} is on unexpectedly",
            },
          ],
        },
      });
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([
        makeEntity({ entityId: "light.kitchen", friendlyName: "Kitchen Light", state: "on" }),
        makeEntity({ entityId: "light.bedroom", friendlyName: "Bedroom Light", state: "off" }),
      ]);

      const result = manager.checkAnomalies();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.entityId).toBe("light.kitchen");
      expect(result.value[0]?.detail).toBe("Kitchen Light is on unexpectedly");
    });

    test("publishes ha:anomaly_detected events", () => {
      const deps = makeDeps({
        anomalyDetection: {
          enabled: true,
          rules: [
            {
              entityPattern: "*",
              condition: "state == on",
              message: "Anomaly: {entityId}",
            },
          ],
        },
      });
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([makeEntity({ entityId: "light.kitchen", state: "on" })]);
      manager.checkAnomalies();

      const anomalyEvents = deps.eventBus.published.filter((e) => e.type === "ha:anomaly_detected");
      expect(anomalyEvents.length).toBe(1);
    });

    test("returns empty array when anomaly detection is disabled", () => {
      const deps = makeDeps({
        anomalyDetection: { enabled: false, rules: [] },
      });
      const manager = new HAManager({ ...deps, logger });

      const result = manager.checkAnomalies();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(0);
    });

    test("supports state != condition", () => {
      const deps = makeDeps({
        anomalyDetection: {
          enabled: true,
          rules: [
            {
              entityPattern: "lock.*",
              condition: "state != locked",
              message: "{friendlyName} is not locked",
            },
          ],
        },
      });
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([
        makeEntity({ entityId: "lock.front_door", domain: "lock", friendlyName: "Front Door", state: "unlocked" }),
      ]);

      const result = manager.checkAnomalies();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.detail).toBe("Front Door is not locked");
    });
  });

  // -------------------------------------------------------------------------
  // Context injection
  // -------------------------------------------------------------------------

  describe("injectStateContext", () => {
    test("generates markdown with entities grouped by domain", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([
        makeEntity({ entityId: "light.kitchen", domain: "light", friendlyName: "Kitchen Light", state: "on" }),
        makeEntity({ entityId: "switch.fan", domain: "switch", friendlyName: "Fan", state: "off" }),
        makeEntity({ entityId: "light.bedroom", domain: "light", friendlyName: "Bedroom Light", state: "off" }),
      ]);

      const result = manager.injectStateContext();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toContain("## Home Automation");
      expect(result.value).toContain("### Light");
      expect(result.value).toContain("### Switch");
      expect(result.value).toContain("Kitchen Light: on");
      expect(result.value).toContain("Fan: off");
    });

    test("returns empty string when no entities exist", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      const result = manager.injectStateContext();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // Entity attributes
  // -------------------------------------------------------------------------

  describe("entity attributes", () => {
    test("preserves JSON attributes through sync", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([
        makeEntity({
          entityId: "climate.living_room",
          domain: "climate",
          friendlyName: "Living Room Thermostat",
          attributes: { temperature: 21.5, hvac_mode: "heat" },
        }),
      ]);

      const result = manager.getEntity("climate.living_room");
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.attributes).toEqual({ temperature: 21.5, hvac_mode: "heat" });
    });
  });

  // -------------------------------------------------------------------------
  // injectStateContext edge cases
  // -------------------------------------------------------------------------

  describe("injectStateContext edge cases", () => {
    test("domains are sorted alphabetically", () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      manager.syncEntities([
        makeEntity({ entityId: "switch.x", domain: "switch", friendlyName: "Switch X", state: "on" }),
        makeEntity({ entityId: "climate.y", domain: "climate", friendlyName: "Climate Y", state: "cool" }),
        makeEntity({ entityId: "light.z", domain: "light", friendlyName: "Light Z", state: "off" }),
      ]);

      const result = manager.injectStateContext();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const text = result.value;
      const climateIdx = text.indexOf("### Climate");
      const lightIdx = text.indexOf("### Light");
      const switchIdx = text.indexOf("### Switch");
      expect(climateIdx).toBeLessThan(lightIdx);
      expect(lightIdx).toBeLessThan(switchIdx);
    });
  });

  // -------------------------------------------------------------------------
  // initialize with existing entities
  // -------------------------------------------------------------------------

  describe("initialize with existing entities", () => {
    test("loads existing entities into previousStates so first sync detects changes", async () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      // Pre-populate the DB with an entity
      deps.db
        .query(
          `INSERT INTO ha_entities (entity_id, domain, friendly_name, state, attributes, last_changed, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("light.existing", "light", "Existing Light", "on", "{}", Date.now(), Date.now());

      await manager.initialize();

      // Now sync with a state change -- should detect the change
      manager.syncEntities([
        makeEntity({ entityId: "light.existing", friendlyName: "Existing Light", state: "off" }),
      ]);

      const stateChanges = deps.eventBus.published.filter((e) => e.type === "ha:state_changed");
      expect(stateChanges.length).toBe(1);

      const payload = stateChanges[0]?.payload as { oldState: string; newState: string };
      expect(payload.oldState).toBe("on");
      expect(payload.newState).toBe("off");

      await manager.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    test("clears internal state without error", async () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      await manager.initialize();
      manager.syncEntities([makeEntity()]);

      await manager.dispose();
      // Should not throw
    });

    test("clears previousStates so no changes detected after dispose", async () => {
      const deps = makeDeps();
      const manager = new HAManager({ ...deps, logger });

      await manager.initialize();
      manager.syncEntities([
        makeEntity({ entityId: "light.a", state: "on", friendlyName: "A" }),
      ]);

      await manager.dispose();

      // After dispose, syncing the same entity should not detect a change
      // because previousStates was cleared (acts as a first-time sync)
      manager.syncEntities([
        makeEntity({ entityId: "light.a", state: "off", friendlyName: "A" }),
      ]);

      const stateChanges = deps.eventBus.published.filter(
        (e) => e.type === "ha:state_changed",
      );
      expect(stateChanges.length).toBe(0);
    });
  });
});
