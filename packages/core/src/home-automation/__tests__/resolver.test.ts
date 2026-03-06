/**
 * Tests for HAEntityResolver.
 *
 * Verifies entity resolution strategies: exact_id, exact_name, fuzzy,
 * and semantic matching against an in-memory SQLite HA entity cache.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { HAEntity } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { HAEntityResolver } from "../resolver.ts";

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
  `);
  return db;
}

function insertEntity(db: Database, entity: Partial<HAEntity> & { entityId: string; domain: string }): void {
  db.query(
    `INSERT INTO ha_entities (entity_id, domain, friendly_name, state, attributes, last_changed, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entity.entityId,
    entity.domain,
    entity.friendlyName ?? entity.entityId,
    entity.state ?? "on",
    JSON.stringify(entity.attributes ?? {}),
    entity.lastChanged ?? Date.now(),
    Date.now(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HAEntityResolver", () => {
  const logger = createSilentLogger();
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

  // -------------------------------------------------------------------------
  // Exact ID match
  // -------------------------------------------------------------------------

  describe("exact ID match", () => {
    test("resolves by exact entity_id", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.living_room",
        domain: "light",
        friendlyName: "Living Room Light",
        state: "on",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("light.living_room");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value?.entityId).toBe("light.living_room");
    });

    test("resolves by exact entity_id case-insensitively", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.living_room",
        domain: "light",
        friendlyName: "Living Room Light",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("Light.Living_Room");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.entityId).toBe("light.living_room");
    });
  });

  // -------------------------------------------------------------------------
  // Exact name match
  // -------------------------------------------------------------------------

  describe("exact name match", () => {
    test("resolves by exact friendly_name", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.kitchen",
        domain: "light",
        friendlyName: "Kitchen Light",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("Kitchen Light");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.entityId).toBe("light.kitchen");
    });

    test("resolves by exact friendly_name case-insensitively", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.kitchen",
        domain: "light",
        friendlyName: "Kitchen Light",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("kitchen light");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.entityId).toBe("light.kitchen");
    });
  });

  // -------------------------------------------------------------------------
  // Fuzzy match
  // -------------------------------------------------------------------------

  describe("fuzzy match", () => {
    test("resolves by fuzzy word overlap", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.living_room",
        domain: "light",
        friendlyName: "Living Room Light",
      });
      insertEntity(db, {
        entityId: "light.bedroom",
        domain: "light",
        friendlyName: "Bedroom Light",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("living room");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.entityId).toBe("light.living_room");
    });

    test("returns best fuzzy match when multiple candidates exist", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.living_room_main",
        domain: "light",
        friendlyName: "Living Room Main Light",
      });
      insertEntity(db, {
        entityId: "light.dining_room",
        domain: "light",
        friendlyName: "Dining Room Light",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("living room main");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.entityId).toBe("light.living_room_main");
    });
  });

  // -------------------------------------------------------------------------
  // Domain filtering
  // -------------------------------------------------------------------------

  describe("domain filtering", () => {
    test("filters entities by domain when specified", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.kitchen",
        domain: "light",
        friendlyName: "Kitchen",
      });
      insertEntity(db, {
        entityId: "switch.kitchen",
        domain: "switch",
        friendlyName: "Kitchen",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("Kitchen", "switch");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value?.entityId).toBe("switch.kitchen");
    });
  });

  // -------------------------------------------------------------------------
  // No match
  // -------------------------------------------------------------------------

  describe("no match", () => {
    test("returns null when no entities match", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.kitchen",
        domain: "light",
        friendlyName: "Kitchen Light",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("garage door");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    test("returns null for empty input", async () => {
      const db = makeDb();
      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    test("returns null when no entities exist", async () => {
      const db = makeDb();
      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolve("anything");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // resolveMultiple
  // -------------------------------------------------------------------------

  describe("resolveMultiple", () => {
    test("resolves multiple comma-separated entity references", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.kitchen",
        domain: "light",
        friendlyName: "Kitchen Light",
      });
      insertEntity(db, {
        entityId: "light.bedroom",
        domain: "light",
        friendlyName: "Bedroom Light",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolveMultiple("Kitchen Light, Bedroom Light");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
      expect(result.value[0]?.entityId).toBe("light.kitchen");
      expect(result.value[1]?.entityId).toBe("light.bedroom");
    });

    test("resolves 'and'-separated entity references", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.kitchen",
        domain: "light",
        friendlyName: "Kitchen Light",
      });
      insertEntity(db, {
        entityId: "light.bedroom",
        domain: "light",
        friendlyName: "Bedroom Light",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolveMultiple("Kitchen Light and Bedroom Light");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(2);
    });

    test("skips unresolved references without failing", async () => {
      const db = makeDb();
      insertEntity(db, {
        entityId: "light.kitchen",
        domain: "light",
        friendlyName: "Kitchen Light",
      });

      const resolver = new HAEntityResolver(db, logger);
      const result = await resolver.resolveMultiple("Kitchen Light, nonexistent thing");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.entityId).toBe("light.kitchen");
    });
  });
});
