/**
 * Tests for calendar-related RPC handlers in the GatewayServer.
 *
 * Verifies that calendar.listEvents, calendar.getUpcoming, calendar.createEvent,
 * and calendar.conflicts handlers are registered when a CalendarManager is
 * provided, and that they validate params, delegate to the CalendarManager,
 * and return correct results.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { GatewayConfig, GatewayResponse } from "@eidolon/protocol";
import { CalendarManager } from "../../calendar/manager.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { GatewayServer } from "../server.ts";

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

const logger = createSilentLogger();

function randomPort(): number {
  return 40_000 + Math.floor(Math.random() * 20_000);
}

function makeConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    host: "127.0.0.1",
    port: randomPort(),
    tls: { enabled: false },
    maxMessageBytes: 1_048_576,
    maxClients: 10,
    allowedOrigins: [],
    rateLimiting: {
      maxFailures: 5,
      windowMs: 60_000,
      blockMs: 300_000,
      maxBlockMs: 3_600_000,
    },
    auth: { type: "none" },
    webhooks: { endpoints: [] },
    ...overrides,
  };
}

function createEventBus(): EventBus {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      payload TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'system',
      timestamp INTEGER NOT NULL,
      processed_at INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0
    )
  `);
  return new EventBus(db, logger);
}

function createCalendarDb(): Database {
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

    CREATE TABLE loop_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}

function createCalendarManager(db: Database, eventBus: EventBus): CalendarManager {
  return new CalendarManager({
    db,
    logger,
    eventBus,
    config: {
      enabled: true,
      providers: [],
      reminders: { defaultMinutesBefore: [15], notifyVia: ["telegram"] },
      injection: { enabled: false, daysAhead: 1 },
    },
  });
}

function connectClient(port: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onopen = (): void => resolve(ws);
    ws.onerror = (ev): void => reject(new Error(`WebSocket error: ${String(ev)}`));
  });
}

function sendAndReceive(ws: WebSocket, data: unknown): Promise<GatewayResponse> {
  return new Promise<GatewayResponse>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for response")), 3_000);
    ws.onmessage = (ev: MessageEvent): void => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(ev.data)) as GatewayResponse);
    };
    ws.send(JSON.stringify(data));
  });
}

// ---------------------------------------------------------------------------
// Track servers for cleanup
// ---------------------------------------------------------------------------

const activeServers: GatewayServer[] = [];
const activeClients: WebSocket[] = [];

afterEach(async () => {
  for (const ws of activeClients) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  activeClients.length = 0;
  for (const s of activeServers) {
    await s.stop();
  }
  activeServers.length = 0;
});

// ---------------------------------------------------------------------------
// Test: handlers not registered when calendarManager is absent
// ---------------------------------------------------------------------------

describe("calendar handlers -- not registered without calendarManager", () => {
  test("calendar.listEvents returns method-not-found when no calendarManager", async () => {
    const config = makeConfig();
    const server = new GatewayServer({ config, logger, eventBus: createEventBus() });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "1",
      method: "calendar.listEvents",
      params: { start: 0, end: 1000 },
    });

    expect(resp.error).toBeDefined();
    expect(resp.error?.code).toBe(-32601); // method not found
  });
});

// ---------------------------------------------------------------------------
// Test: calendar.listEvents
// ---------------------------------------------------------------------------

describe("calendar.listEvents", () => {
  test("returns events within a time range", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    // Insert a test event
    calendar.createEvent({
      calendarId: "cal-1",
      title: "Team Standup",
      startTime: 1_000_000,
      endTime: 1_100_000,
      allDay: false,
      reminders: [],
      source: "manual",
    });

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "1",
      method: "calendar.listEvents",
      params: { start: 900_000, end: 1_200_000 },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as { events: Array<{ title: string }> };
    expect(result.events).toBeArray();
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.title).toBe("Team Standup");
  });

  test("rejects invalid params (missing start)", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "2",
      method: "calendar.listEvents",
      params: { end: 1_000_000 },
    });

    expect(resp.error).toBeDefined();
    expect(resp.error?.code).toBe(-32602); // invalid params
  });
});

// ---------------------------------------------------------------------------
// Test: calendar.getUpcoming
// ---------------------------------------------------------------------------

describe("calendar.getUpcoming", () => {
  test("returns upcoming events with default hours", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    // Insert an event that's "upcoming" (within the next 24 hours from now)
    const now = Date.now();
    calendar.createEvent({
      calendarId: "cal-1",
      title: "Lunch Meeting",
      startTime: now + 3_600_000, // 1 hour from now
      endTime: now + 7_200_000, // 2 hours from now
      allDay: false,
      reminders: [],
      source: "manual",
    });

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "3",
      method: "calendar.getUpcoming",
      params: {},
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as { events: Array<{ title: string }> };
    expect(result.events).toBeArray();
    expect(result.events.length).toBe(1);
    expect(result.events[0]?.title).toBe("Lunch Meeting");
  });

  test("respects custom hours parameter", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    const now = Date.now();
    // Insert an event 3 hours from now
    calendar.createEvent({
      calendarId: "cal-1",
      title: "Far Away Event",
      startTime: now + 3 * 3_600_000,
      endTime: now + 4 * 3_600_000,
      allDay: false,
      reminders: [],
      source: "manual",
    });

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    // Request only 1 hour ahead -- should NOT include the event
    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "4",
      method: "calendar.getUpcoming",
      params: { hours: 1 },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as { events: Array<{ title: string }> };
    expect(result.events.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test: calendar.createEvent
// ---------------------------------------------------------------------------

describe("calendar.createEvent", () => {
  test("creates an event and returns it", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "5",
      method: "calendar.createEvent",
      params: {
        title: "New Event",
        startTime: 5_000_000,
        endTime: 5_500_000,
        description: "A test event",
        location: "Office",
      },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      id: string;
      title: string;
      description: string;
      location: string;
      calendarId: string;
    };
    expect(result.title).toBe("New Event");
    expect(result.description).toBe("A test event");
    expect(result.location).toBe("Office");
    expect(result.calendarId).toBe("default");
    expect(typeof result.id).toBe("string");
  });

  test("rejects when title is missing", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "6",
      method: "calendar.createEvent",
      params: { startTime: 5_000_000, endTime: 5_500_000 },
    });

    expect(resp.error).toBeDefined();
    expect(resp.error?.code).toBe(-32602);
  });

  test("uses provided calendarId instead of default", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "7",
      method: "calendar.createEvent",
      params: {
        title: "Work Meeting",
        startTime: 6_000_000,
        endTime: 6_500_000,
        calendarId: "work-cal",
      },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as { calendarId: string };
    expect(result.calendarId).toBe("work-cal");
  });
});

// ---------------------------------------------------------------------------
// Test: calendar.conflicts
// ---------------------------------------------------------------------------

describe("calendar.conflicts", () => {
  test("detects overlapping events", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    // Create two overlapping events
    calendar.createEvent({
      calendarId: "cal-1",
      title: "Meeting A",
      startTime: 10_000_000,
      endTime: 11_000_000,
      allDay: false,
      reminders: [],
      source: "manual",
    });
    calendar.createEvent({
      calendarId: "cal-1",
      title: "Meeting B",
      startTime: 10_500_000,
      endTime: 11_500_000,
      allDay: false,
      reminders: [],
      source: "manual",
    });

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "8",
      method: "calendar.conflicts",
      params: { start: 9_000_000, end: 12_000_000 },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      conflicts: Array<{ titles: string[]; overlapStart: number; overlapEnd: number }>;
    };
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]?.titles).toContain("Meeting A");
    expect(result.conflicts[0]?.titles).toContain("Meeting B");
    expect(result.conflicts[0]?.overlapStart).toBe(10_500_000);
    expect(result.conflicts[0]?.overlapEnd).toBe(11_000_000);
  });

  test("returns empty array when no conflicts exist", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    // Create two non-overlapping events
    calendar.createEvent({
      calendarId: "cal-1",
      title: "Morning",
      startTime: 10_000_000,
      endTime: 11_000_000,
      allDay: false,
      reminders: [],
      source: "manual",
    });
    calendar.createEvent({
      calendarId: "cal-1",
      title: "Afternoon",
      startTime: 12_000_000,
      endTime: 13_000_000,
      allDay: false,
      reminders: [],
      source: "manual",
    });

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "9",
      method: "calendar.conflicts",
      params: { start: 9_000_000, end: 14_000_000 },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as { conflicts: unknown[] };
    expect(result.conflicts.length).toBe(0);
  });

  test("uses default 7-day window when no params provided", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    // Should succeed even with empty params (defaults to now..now+7d)
    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "10",
      method: "calendar.conflicts",
      params: {},
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as { conflicts: unknown[] };
    expect(result.conflicts).toBeArray();
  });

  test("ignores all-day events for conflict detection", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const calDb = createCalendarDb();
    const calendar = createCalendarManager(calDb, eventBus);

    // Create an all-day event and a regular event in the same time range
    calendar.createEvent({
      calendarId: "cal-1",
      title: "All Day Holiday",
      startTime: 10_000_000,
      endTime: 10_000_000 + 86_400_000,
      allDay: true,
      reminders: [],
      source: "manual",
    });
    calendar.createEvent({
      calendarId: "cal-1",
      title: "Regular Meeting",
      startTime: 10_000_000 + 3_600_000,
      endTime: 10_000_000 + 7_200_000,
      allDay: false,
      reminders: [],
      source: "manual",
    });

    const server = new GatewayServer({ config, logger, eventBus, calendarManager: calendar });
    activeServers.push(server);
    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    const resp = await sendAndReceive(ws, {
      jsonrpc: "2.0",
      id: "11",
      method: "calendar.conflicts",
      params: { start: 9_000_000, end: 11_000_000 + 86_400_000 },
    });

    expect(resp.error).toBeUndefined();
    const result = resp.result as { conflicts: unknown[] };
    // All-day events are excluded from conflict detection, so no conflicts
    expect(result.conflicts.length).toBe(0);
  });
});
