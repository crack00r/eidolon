/**
 * Tests for CalendarManager.
 *
 * Uses mock CalendarProvider implementations and in-memory SQLite
 * to verify event management, sync, conflict detection, and persistence.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type {
  CalendarConfig,
  CalendarEvent,
  CalendarProvider,
  CalendarSyncResult,
  EidolonError,
  Result,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { EventBus } from "../../loop/event-bus.ts";
import { CalendarManager } from "../manager.ts";

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
    CREATE TABLE calendar_events (
      id TEXT PRIMARY KEY,
      calendar_id TEXT NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('google', 'caldav', 'manual')),
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      recurrence TEXT,
      reminders TEXT NOT NULL DEFAULT '[]',
      raw_data TEXT,
      sync_token TEXT,
      synced_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_calendar_events_time ON calendar_events(start_time, end_time);
    CREATE INDEX idx_calendar_events_provider ON calendar_events(provider);
    CREATE INDEX idx_calendar_events_calendar ON calendar_events(calendar_id);

    CREATE TABLE loop_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

/** Minimal mock EventBus that records published events. */
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

/** Create a mock CalendarProvider that returns canned events. */
function createMockProvider(
  id: string,
  name: string,
  events: CalendarEvent[] = [],
  syncResult?: CalendarSyncResult,
): CalendarProvider {
  return {
    id,
    name,
    connect: async (): Promise<Result<void, EidolonError>> => Ok(undefined),
    disconnect: async (): Promise<void> => {},
    listEvents: async (): Promise<Result<CalendarEvent[], EidolonError>> => Ok(events),
    createEvent: async (
      event: Omit<CalendarEvent, "id" | "syncedAt">,
    ): Promise<Result<CalendarEvent, EidolonError>> => {
      const created: CalendarEvent = {
        ...event,
        id: `new-${Date.now()}`,
        syncedAt: Date.now(),
      };
      return Ok(created);
    },
    deleteEvent: async (): Promise<Result<void, EidolonError>> => Ok(undefined),
    sync: async (): Promise<Result<CalendarSyncResult, EidolonError>> =>
      Ok(syncResult ?? { added: events.length, updated: 0, deleted: 0, syncToken: "tok-1" }),
  };
}

function makeConfig(overrides?: Partial<CalendarConfig>): CalendarConfig {
  return {
    enabled: true,
    providers: [],
    reminders: { defaultMinutesBefore: [15, 60], notifyVia: ["telegram"] },
    injection: { enabled: true, daysAhead: 1 },
    ...overrides,
  };
}

function makeEvent(overrides?: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "evt-1",
    calendarId: "cal-1",
    title: "Test Meeting",
    startTime: Date.now() + 3_600_000,
    endTime: Date.now() + 7_200_000,
    allDay: false,
    reminders: [15],
    source: "manual",
    syncedAt: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CalendarManager", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  function makeDeps(configOverrides?: Partial<CalendarConfig>): {
    db: Database;
    eventBus: ReturnType<typeof createMockEventBus>;
    config: CalendarConfig;
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
  // registerProvider / getProviders
  // -------------------------------------------------------------------------

  describe("registerProvider", () => {
    test("registers a provider that can be synced", async () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });
      const provider = createMockProvider("google-primary", "Google Primary");

      manager.registerProvider(provider);

      const syncResult = await manager.sync("google-primary");
      expect(syncResult.ok).toBe(true);
    });

    test("registers multiple providers", async () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      manager.registerProvider(createMockProvider("google-1", "Google 1"));
      manager.registerProvider(createMockProvider("caldav-1", "CalDAV 1"));

      // Sync all providers
      const syncResult = await manager.sync();
      expect(syncResult.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  describe("sync", () => {
    test("syncAll calls sync on all providers and aggregates results", async () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      manager.registerProvider(createMockProvider("p1", "P1", [], { added: 3, updated: 1, deleted: 0 }));
      manager.registerProvider(createMockProvider("p2", "P2", [], { added: 2, updated: 0, deleted: 1 }));

      const result = await manager.sync();
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.added).toBe(5);
      expect(result.value.updated).toBe(1);
      expect(result.value.deleted).toBe(1);
    });

    test("publishes calendar:sync_completed event", async () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      manager.registerProvider(createMockProvider("p1", "P1"));

      await manager.sync();

      const syncEvents = deps.eventBus.published.filter((e) => e.type === "calendar:sync_completed");
      expect(syncEvents.length).toBe(1);
    });

    test("returns error when provider not found", async () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const result = await manager.sync("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCode.CALENDAR_PROVIDER_ERROR);
    });
  });

  // -------------------------------------------------------------------------
  // listEvents
  // -------------------------------------------------------------------------

  describe("listEvents", () => {
    test("returns events within the specified time range", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const now = Date.now();
      const event1 = makeEvent({ id: "e1", startTime: now + 1_000, endTime: now + 2_000 });
      const event2 = makeEvent({ id: "e2", startTime: now + 5_000, endTime: now + 6_000 });
      const event3 = makeEvent({ id: "e3", startTime: now + 100_000, endTime: now + 200_000 });

      manager.upsertEvent(event1);
      manager.upsertEvent(event2);
      manager.upsertEvent(event3);

      const result = manager.listEvents(now, now + 10_000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.length).toBe(2);
      expect(result.value[0]?.id).toBe("e1");
      expect(result.value[1]?.id).toBe("e2");
    });

    test("merges events from multiple providers in the cache", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const now = Date.now();
      const googleEvent = makeEvent({
        id: "g1",
        source: "google",
        calendarId: "google-primary",
        startTime: now + 2_000,
        endTime: now + 3_000,
      });
      const caldavEvent = makeEvent({
        id: "c1",
        source: "caldav",
        calendarId: "caldav-work",
        startTime: now + 1_000,
        endTime: now + 4_000,
      });

      manager.upsertEvent(googleEvent);
      manager.upsertEvent(caldavEvent);

      const result = manager.listEvents(now, now + 10_000);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.length).toBe(2);
      // Sorted by start_time ascending
      expect(result.value[0]?.id).toBe("c1");
      expect(result.value[1]?.id).toBe("g1");
    });

    test("returns empty array when no events match", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const result = manager.listEvents(0, 1);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // createEvent
  // -------------------------------------------------------------------------

  describe("createEvent", () => {
    test("creates a manual event and stores it in DB", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const now = Date.now();
      const result = manager.createEvent({
        calendarId: "manual",
        title: "Lunch",
        startTime: now + 3_600_000,
        endTime: now + 5_400_000,
        allDay: false,
        reminders: [15],
        source: "manual",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.title).toBe("Lunch");
      expect(result.value.id).toBeTruthy();

      // Verify in DB
      const dbResult = manager.listEvents(now, now + 10_000_000);
      expect(dbResult.ok).toBe(true);
      if (!dbResult.ok) return;
      expect(dbResult.value.some((e) => e.title === "Lunch")).toBe(true);
    });

    test("publishes calendar:event_created event", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const now = Date.now();
      manager.createEvent({
        calendarId: "manual",
        title: "Standup",
        startTime: now + 1_000,
        endTime: now + 2_000,
        allDay: false,
        reminders: [],
        source: "manual",
      });

      const createdEvents = deps.eventBus.published.filter((e) => e.type === "calendar:event_created");
      expect(createdEvents.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // deleteEvent
  // -------------------------------------------------------------------------

  describe("deleteEvent", () => {
    test("removes an event from the DB", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const event = makeEvent({ id: "del-1" });
      manager.upsertEvent(event);

      const deleteResult = manager.deleteEvent("del-1");
      expect(deleteResult.ok).toBe(true);

      const now = Date.now();
      const listResult = manager.listEvents(now - 1_000_000, now + 1_000_000);
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) return;
      expect(listResult.value.find((e) => e.id === "del-1")).toBeUndefined();
    });

    test("returns error for non-existent event", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const result = manager.deleteEvent("nonexistent");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe(ErrorCode.CALENDAR_EVENT_NOT_FOUND);
    });
  });

  // -------------------------------------------------------------------------
  // getUpcoming
  // -------------------------------------------------------------------------

  describe("getUpcoming", () => {
    test("returns events in the future sorted by time", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const now = Date.now();
      const event1 = makeEvent({
        id: "u1",
        title: "Later",
        startTime: now + 7_200_000,
        endTime: now + 7_400_000,
      });
      const event2 = makeEvent({
        id: "u2",
        title: "Sooner",
        startTime: now + 1_800_000,
        endTime: now + 2_000_000,
      });
      const event3 = makeEvent({
        id: "u3",
        title: "Past",
        startTime: now - 3_600_000,
        endTime: now - 1_800_000,
      });

      manager.upsertEvent(event1);
      manager.upsertEvent(event2);
      manager.upsertEvent(event3);

      const result = manager.getUpcoming(3);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Past event should not be included, future events sorted by start_time
      expect(result.value.length).toBe(2);
      expect(result.value[0]?.title).toBe("Sooner");
      expect(result.value[1]?.title).toBe("Later");
    });
  });

  // -------------------------------------------------------------------------
  // detectConflicts (via createEvent)
  // -------------------------------------------------------------------------

  describe("detectConflicts", () => {
    test("publishes conflict event for overlapping events", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const now = Date.now();
      // Insert an existing event
      const existing = makeEvent({
        id: "existing-1",
        title: "Existing Meeting",
        startTime: now + 1_000,
        endTime: now + 3_600_000,
      });
      manager.upsertEvent(existing);

      // Create an overlapping event
      manager.createEvent({
        calendarId: "manual",
        title: "Overlapping Meeting",
        startTime: now + 1_800_000,
        endTime: now + 5_400_000,
        allDay: false,
        reminders: [],
        source: "manual",
      });

      const conflicts = deps.eventBus.published.filter((e) => e.type === "calendar:conflict_detected");
      expect(conflicts.length).toBe(1);
    });

    test("does not report conflict for all-day events", () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      const now = Date.now();
      const existing = makeEvent({
        id: "existing-2",
        title: "All Day Event",
        startTime: now,
        endTime: now + 86_400_000,
        allDay: true,
      });
      manager.upsertEvent(existing);

      manager.createEvent({
        calendarId: "manual",
        title: "Normal Meeting",
        startTime: now + 1_000,
        endTime: now + 3_600_000,
        allDay: false,
        reminders: [],
        source: "manual",
      });

      // The all-day event should be filtered out from conflicts
      const conflicts = deps.eventBus.published.filter((e) => e.type === "calendar:conflict_detected");
      expect(conflicts.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // DB persistence
  // -------------------------------------------------------------------------

  describe("persistence", () => {
    test("events survive re-instantiation of CalendarManager", () => {
      const deps = makeDeps();
      const now = Date.now();

      // First manager instance
      const manager1 = new CalendarManager({ ...deps, logger });
      const event = makeEvent({
        id: "persist-1",
        title: "Persistent Event",
        startTime: now + 1_000,
        endTime: now + 2_000,
      });
      manager1.upsertEvent(event);

      // Second manager instance with the same DB
      const manager2 = new CalendarManager({ ...deps, logger });
      const result = manager2.listEvents(now, now + 10_000);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.length).toBe(1);
      expect(result.value[0]?.id).toBe("persist-1");
      expect(result.value[0]?.title).toBe("Persistent Event");
    });
  });

  // -------------------------------------------------------------------------
  // initialize
  // -------------------------------------------------------------------------

  describe("initialize", () => {
    test("connects all providers when enabled", async () => {
      const deps = makeDeps({ enabled: true });
      const manager = new CalendarManager({ ...deps, logger });

      let connected = false;
      const provider: CalendarProvider = {
        id: "test-init",
        name: "Test Init",
        connect: async () => {
          connected = true;
          return Ok(undefined);
        },
        disconnect: async () => {},
        listEvents: async () => Ok([]),
        createEvent: async () => Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "not implemented")),
        deleteEvent: async () => Ok(undefined),
        sync: async () => Ok({ added: 0, updated: 0, deleted: 0 }),
      };

      manager.registerProvider(provider);
      const result = await manager.initialize();

      expect(result.ok).toBe(true);
      expect(connected).toBe(true);
    });

    test("skips initialization when disabled", async () => {
      const deps = makeDeps({ enabled: false });
      const manager = new CalendarManager({ ...deps, logger });

      const result = await manager.initialize();
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // dispose
  // -------------------------------------------------------------------------

  describe("dispose", () => {
    test("disconnects all providers", async () => {
      const deps = makeDeps();
      const manager = new CalendarManager({ ...deps, logger });

      let disconnected = false;
      const provider: CalendarProvider = {
        id: "test-dispose",
        name: "Test Dispose",
        connect: async () => Ok(undefined),
        disconnect: async () => {
          disconnected = true;
        },
        listEvents: async () => Ok([]),
        createEvent: async () => Err(createError(ErrorCode.CALENDAR_PROVIDER_ERROR, "not implemented")),
        deleteEvent: async () => Ok(undefined),
        sync: async () => Ok({ added: 0, updated: 0, deleted: 0 }),
      };

      manager.registerProvider(provider);
      await manager.dispose();

      expect(disconnected).toBe(true);
    });
  });
});
