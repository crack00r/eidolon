import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Channel, ChannelCapabilities, InboundMessage, OutboundMessage } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { isDndActive, MessageRouter } from "../router.ts";

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
  if (!result.ok) throw new Error("Failed to run migrations");
  return db;
}

const TEST_CAPABILITIES: ChannelCapabilities = {
  text: true,
  markdown: false,
  images: false,
  documents: false,
  voice: false,
  reactions: false,
  editing: false,
  streaming: false,
};

function createMockChannel(id = "test"): Channel & { sentMessages: OutboundMessage[] } {
  const sentMessages: OutboundMessage[] = [];
  return {
    id,
    name: `Test-${id}`,
    capabilities: TEST_CAPABILITIES,
    connect: async () => Ok(undefined),
    disconnect: async () => {},
    send: async (msg: OutboundMessage) => {
      sentMessages.push(msg);
      return Ok(undefined);
    },
    onMessage: () => {},
    isConnected: () => true,
    sentMessages,
  };
}

describe("MessageRouter", () => {
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

  test("registerChannel stores channel", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger);
    const channel = createMockChannel();

    router.registerChannel(channel);

    expect(router.getChannel("test")).toBe(channel);
    expect(router.getChannels()).toHaveLength(1);
  });

  test("unregisterChannel removes channel", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger);
    const channel = createMockChannel();

    router.registerChannel(channel);
    router.unregisterChannel("test");

    expect(router.getChannel("test")).toBeUndefined();
    expect(router.getChannels()).toHaveLength(0);
  });

  test("routeInbound publishes user:message event", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger);

    const received: unknown[] = [];
    bus.subscribe("user:message", (event) => {
      received.push(event.payload);
    });

    const inbound: InboundMessage = {
      id: "msg-1",
      channelId: "telegram",
      userId: "user-42",
      text: "Hello, Eidolon!",
      timestamp: Date.now(),
    };

    const result = router.routeInbound(inbound);
    expect(result.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({
      channelId: "telegram",
      userId: "user-42",
      text: "Hello, Eidolon!",
      attachments: undefined,
    });
  });

  test("routeOutbound sends to correct channel", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger);
    const channel = createMockChannel("mychannel");

    router.registerChannel(channel);

    const outbound: OutboundMessage = {
      id: "out-1",
      channelId: "mychannel",
      text: "Response text",
    };

    const result = await router.routeOutbound(outbound);
    expect(result.ok).toBe(true);
    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]?.text).toBe("Response text");
  });

  test("routeOutbound returns error for unknown channel", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger);

    const outbound: OutboundMessage = {
      id: "out-1",
      channelId: "nonexistent",
      text: "Hello",
    };

    const result = await router.routeOutbound(outbound);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CHANNEL_SEND_FAILED");
    }
  });

  test("getChannels returns all registered", () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger);

    router.registerChannel(createMockChannel("ch-a"));
    router.registerChannel(createMockChannel("ch-b"));
    router.registerChannel(createMockChannel("ch-c"));

    const channels = router.getChannels();
    expect(channels).toHaveLength(3);

    const ids = channels.map((c) => c.id);
    expect(ids).toContain("ch-a");
    expect(ids).toContain("ch-b");
    expect(ids).toContain("ch-c");
  });

  test("sendNotification suppresses normal during DND", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    // DND from 22:00 to 07:00, current time set to 23:30
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00" },
      nowProvider: () => new Date(2026, 2, 3, 23, 30),
    });
    const channel = createMockChannel("test");
    router.registerChannel(channel);

    const outbound: OutboundMessage = {
      id: "notif-1",
      channelId: "test",
      text: "New learning discovery",
    };

    const result = await router.sendNotification(outbound, "normal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(false); // suppressed
    }
    expect(channel.sentMessages).toHaveLength(0);
  });

  test("sendNotification allows critical during DND", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00" },
      nowProvider: () => new Date(2026, 2, 3, 23, 30),
    });
    const channel = createMockChannel("test");
    router.registerChannel(channel);

    const outbound: OutboundMessage = {
      id: "notif-2",
      channelId: "test",
      text: "Security alert!",
    };

    const result = await router.sendNotification(outbound, "critical");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true); // sent
    }
    expect(channel.sentMessages).toHaveLength(1);
  });

  test("sendNotification sends normal outside DND", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00" },
      nowProvider: () => new Date(2026, 2, 3, 14, 0), // 2 PM -- outside DND
    });
    const channel = createMockChannel("test");
    router.registerChannel(channel);

    const outbound: OutboundMessage = {
      id: "notif-3",
      channelId: "test",
      text: "Learning discovery",
    };

    const result = await router.sendNotification(outbound, "normal");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(true); // sent
    }
    expect(channel.sentMessages).toHaveLength(1);
  });
});

describe("isDndActive", () => {
  // -- Cross-midnight window --------------------------------------------------

  test("cross-midnight window active at 23:30", () => {
    const schedule = { start: "22:00", end: "07:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 23, 30));
    expect(active).toBe(true);
  });

  test("cross-midnight window active at 03:00", () => {
    const schedule = { start: "22:00", end: "07:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 3, 0));
    expect(active).toBe(true);
  });

  test("cross-midnight window active at exactly start time", () => {
    const schedule = { start: "22:00", end: "07:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 22, 0));
    expect(active).toBe(true);
  });

  test("cross-midnight window active at midnight", () => {
    const schedule = { start: "22:00", end: "07:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 0, 0));
    expect(active).toBe(true);
  });

  test("cross-midnight window inactive at end time", () => {
    // end time is exclusive: 07:00 is NOT in the DND window
    const schedule = { start: "22:00", end: "07:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 7, 0));
    expect(active).toBe(false);
  });

  test("cross-midnight window inactive at 14:00", () => {
    const schedule = { start: "22:00", end: "07:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 14, 0));
    expect(active).toBe(false);
  });

  test("cross-midnight window inactive just before start", () => {
    const schedule = { start: "22:00", end: "07:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 21, 59));
    expect(active).toBe(false);
  });

  // -- Same-day window --------------------------------------------------------

  test("same-day window active at 12:00", () => {
    const schedule = { start: "09:00", end: "17:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 12, 0));
    expect(active).toBe(true);
  });

  test("same-day window active at start time", () => {
    const schedule = { start: "09:00", end: "17:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 9, 0));
    expect(active).toBe(true);
  });

  test("same-day window inactive at end time", () => {
    const schedule = { start: "09:00", end: "17:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 17, 0));
    expect(active).toBe(false);
  });

  test("same-day window inactive at 20:00", () => {
    const schedule = { start: "09:00", end: "17:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 20, 0));
    expect(active).toBe(false);
  });

  // -- Edge cases -------------------------------------------------------------

  test("returns false for invalid schedule format", () => {
    const schedule = { start: "invalid", end: "also-invalid" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 12, 0));
    expect(active).toBe(false);
  });

  test("start equals end means empty window (always inactive)", () => {
    const schedule = { start: "12:00", end: "12:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 12, 0));
    expect(active).toBe(false);
  });

  // -- Timezone support -------------------------------------------------------

  test("timezone-aware DND uses specified timezone", () => {
    // Create a UTC timestamp for 2026-01-15T23:30:00Z
    // In Europe/Berlin (CET, UTC+1), this is 00:30 on Jan 16
    // DND from 22:00-07:00 Berlin time: 00:30 Berlin is inside DND
    const utcDate = new Date(Date.UTC(2026, 0, 15, 23, 30, 0));
    const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };

    const active = isDndActive(schedule, () => utcDate);
    expect(active).toBe(true);
  });

  test("timezone-aware DND inactive when outside window in target timezone", () => {
    // Create a UTC timestamp for 2026-01-15T13:00:00Z
    // In Europe/Berlin (CET, UTC+1), this is 14:00
    // DND from 22:00-07:00 Berlin time: 14:00 Berlin is outside DND
    const utcDate = new Date(Date.UTC(2026, 0, 15, 13, 0, 0));
    const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };

    const active = isDndActive(schedule, () => utcDate);
    expect(active).toBe(false);
  });

  test("timezone-aware DND with US timezone", () => {
    // Create a UTC timestamp for 2026-07-15T03:00:00Z
    // In America/New_York (EDT, UTC-4), this is 23:00 on Jul 14
    // DND from 22:00-07:00 NYC time: 23:00 NYC is inside DND
    const utcDate = new Date(Date.UTC(2026, 6, 15, 3, 0, 0));
    const schedule = { start: "22:00", end: "07:00", timezone: "America/New_York" };

    const active = isDndActive(schedule, () => utcDate);
    expect(active).toBe(true);
  });

  test("timezone-aware DND falls back to local time for invalid timezone", () => {
    // With an invalid timezone, should fall back to local time behavior
    // This test verifies no crash occurs
    const schedule = { start: "22:00", end: "07:00", timezone: "Invalid/Timezone" };
    // Should not throw -- falls back gracefully
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 14, 0));
    expect(active).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Dedicated DND integration tests with MessageRouter
// ---------------------------------------------------------------------------

describe("MessageRouter DND integration", () => {
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

  test("low priority notifications are suppressed during DND", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00" },
      nowProvider: () => new Date(2026, 0, 1, 1, 0), // 01:00 - inside DND
    });
    const channel = createMockChannel("test");
    router.registerChannel(channel);

    const result = await router.sendNotification({ id: "n-1", channelId: "test", text: "Low priority" }, "low");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(false);
    expect(channel.sentMessages).toHaveLength(0);
  });

  test("critical notifications bypass DND at midnight", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00" },
      nowProvider: () => new Date(2026, 0, 1, 0, 0), // midnight - inside DND
    });
    const channel = createMockChannel("test");
    router.registerChannel(channel);

    const result = await router.sendNotification({ id: "n-2", channelId: "test", text: "Security alert" }, "critical");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
    expect(channel.sentMessages).toHaveLength(1);
  });

  test("DND with timezone uses correct timezone for evaluation", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    // UTC timestamp: 2026-01-15T23:30Z = 00:30 Berlin time (inside 22:00-07:00 DND)
    const utcDate = new Date(Date.UTC(2026, 0, 15, 23, 30, 0));
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00", timezone: "Europe/Berlin" },
      nowProvider: () => utcDate,
    });
    const channel = createMockChannel("test");
    router.registerChannel(channel);

    const result = await router.sendNotification(
      { id: "n-3", channelId: "test", text: "Normal notification" },
      "normal",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(false); // suppressed - DND active in Berlin
    expect(channel.sentMessages).toHaveLength(0);
  });

  test("routeOutbound always sends regardless of DND", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00" },
      nowProvider: () => new Date(2026, 0, 1, 23, 30), // inside DND
    });
    const channel = createMockChannel("test");
    router.registerChannel(channel);

    // routeOutbound is for direct user responses and bypasses DND
    const result = await router.routeOutbound({
      id: "resp-1",
      channelId: "test",
      text: "User response",
    });
    expect(result.ok).toBe(true);
    expect(channel.sentMessages).toHaveLength(1);
  });

  test("no DND schedule means all notifications are sent", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    // No dndSchedule provided
    const router = new MessageRouter(bus, logger);
    const channel = createMockChannel("test");
    router.registerChannel(channel);

    const result = await router.sendNotification(
      { id: "n-4", channelId: "test", text: "Normal notification" },
      "normal",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
    expect(channel.sentMessages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Comprehensive timezone-aware DND tests
// ---------------------------------------------------------------------------

describe("isDndActive timezone-aware", () => {
  // ---- Europe/Berlin: CET (UTC+1) in winter, CEST (UTC+2) in summer ------

  describe("Europe/Berlin timezone", () => {
    const berlinSchedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };

    test("active during DND hours in Berlin winter (CET, UTC+1)", () => {
      // 2026-01-15T22:30:00 UTC = 23:30 Berlin (CET) -- inside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 22, 30, 0));
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(true);
    });

    test("inactive outside DND hours in Berlin winter (CET, UTC+1)", () => {
      // 2026-01-15T09:00:00 UTC = 10:00 Berlin (CET) -- outside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 9, 0, 0));
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(false);
    });

    test("active during DND hours in Berlin summer (CEST, UTC+2)", () => {
      // 2026-07-15T21:00:00 UTC = 23:00 Berlin (CEST) -- inside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 6, 15, 21, 0, 0));
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(true);
    });

    test("inactive outside DND hours in Berlin summer (CEST, UTC+2)", () => {
      // 2026-07-15T08:00:00 UTC = 10:00 Berlin (CEST) -- outside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 6, 15, 8, 0, 0));
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(false);
    });

    test("active at midnight Berlin time in winter", () => {
      // 2026-01-15T23:00:00 UTC = 00:00 Berlin (CET) -- inside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 23, 0, 0));
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(true);
    });

    test("inactive at exactly 07:00 Berlin time (end is exclusive)", () => {
      // 2026-01-16T06:00:00 UTC = 07:00 Berlin (CET) -- end boundary, exclusive
      const utcDate = new Date(Date.UTC(2026, 0, 16, 6, 0, 0));
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(false);
    });

    test("active at exactly 22:00 Berlin time (start is inclusive)", () => {
      // 2026-01-15T21:00:00 UTC = 22:00 Berlin (CET) -- start boundary, inclusive
      const utcDate = new Date(Date.UTC(2026, 0, 15, 21, 0, 0));
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(true);
    });

    test("inactive one minute before DND start in Berlin", () => {
      // 2026-01-15T20:59:00 UTC = 21:59 Berlin (CET) -- one minute before DND
      const utcDate = new Date(Date.UTC(2026, 0, 15, 20, 59, 0));
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(false);
    });

    test("active one minute before DND end in Berlin", () => {
      // 2026-01-16T05:59:00 UTC = 06:59 Berlin (CET) -- one minute before end
      const utcDate = new Date(Date.UTC(2026, 0, 16, 5, 59, 0));
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(true);
    });
  });

  // ---- America/New_York: EST (UTC-5) in winter, EDT (UTC-4) in summer ----

  describe("America/New_York timezone", () => {
    const nySchedule = { start: "22:00", end: "07:00", timezone: "America/New_York" };

    test("active during DND hours in NYC winter (EST, UTC-5)", () => {
      // 2026-01-16T04:00:00 UTC = 23:00 NYC (EST) -- inside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 0, 16, 4, 0, 0));
      expect(isDndActive(nySchedule, () => utcDate)).toBe(true);
    });

    test("inactive outside DND hours in NYC winter (EST, UTC-5)", () => {
      // 2026-01-15T17:00:00 UTC = 12:00 NYC (EST) -- outside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 17, 0, 0));
      expect(isDndActive(nySchedule, () => utcDate)).toBe(false);
    });

    test("active during DND hours in NYC summer (EDT, UTC-4)", () => {
      // 2026-07-15T03:00:00 UTC = 23:00 NYC (EDT) -- inside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 6, 15, 3, 0, 0));
      expect(isDndActive(nySchedule, () => utcDate)).toBe(true);
    });

    test("inactive outside DND hours in NYC summer (EDT, UTC-4)", () => {
      // 2026-07-15T15:00:00 UTC = 11:00 NYC (EDT) -- outside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 6, 15, 15, 0, 0));
      expect(isDndActive(nySchedule, () => utcDate)).toBe(false);
    });
  });

  // ---- Cross-timezone comparison: same UTC instant, different DND results -

  describe("same UTC instant evaluated in different timezones", () => {
    test("UTC 21:30 is DND in Berlin (22:30 CET) but not in NYC (16:30 EST)", () => {
      const utcDate = new Date(Date.UTC(2026, 0, 15, 21, 30, 0));

      const berlinSchedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      const nySchedule = { start: "22:00", end: "07:00", timezone: "America/New_York" };

      // Berlin: 21:30 UTC = 22:30 CET -> inside DND
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(true);
      // NYC: 21:30 UTC = 16:30 EST -> outside DND
      expect(isDndActive(nySchedule, () => utcDate)).toBe(false);
    });

    test("UTC 03:00 is not DND in Berlin (04:00 CET) summer but is DND in NYC (23:00 EDT)", () => {
      // July -- CEST (UTC+2) and EDT (UTC-4)
      const utcDate = new Date(Date.UTC(2026, 6, 15, 3, 0, 0));

      const berlinSchedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      const nySchedule = { start: "22:00", end: "07:00", timezone: "America/New_York" };

      // Berlin: 03:00 UTC = 05:00 CEST -> inside DND (before 07:00)
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(true);
      // NYC: 03:00 UTC = 23:00 EDT -> inside DND
      expect(isDndActive(nySchedule, () => utcDate)).toBe(true);
    });

    test("UTC 12:00 is afternoon in both Berlin and NYC -- both outside DND", () => {
      const utcDate = new Date(Date.UTC(2026, 0, 15, 12, 0, 0));

      const berlinSchedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      const nySchedule = { start: "22:00", end: "07:00", timezone: "America/New_York" };

      // Berlin: 12:00 UTC = 13:00 CET -> outside DND
      expect(isDndActive(berlinSchedule, () => utcDate)).toBe(false);
      // NYC: 12:00 UTC = 07:00 EST -> exactly at end boundary (exclusive) -> outside DND
      expect(isDndActive(nySchedule, () => utcDate)).toBe(false);
    });
  });

  // ---- DST transition edge cases ------------------------------------------

  describe("DST transition handling", () => {
    test("spring forward: Berlin CET to CEST transition (last Sunday of March)", () => {
      // 2026-03-29 is the last Sunday of March 2026.
      // At 02:00 CET, clocks spring forward to 03:00 CEST.
      // So 2026-03-29T00:30:00 UTC = 01:30 CET (before transition, still CET UTC+1)
      // DND 22:00-07:00: 01:30 is inside DND
      const utcDate = new Date(Date.UTC(2026, 2, 29, 0, 30, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });

    test("spring forward: just after transition Berlin time jumps from 02:00 to 03:00", () => {
      // 2026-03-29T01:00:00 UTC = 03:00 CEST (after spring forward, UTC+2)
      // DND 22:00-07:00: 03:00 is inside DND
      const utcDate = new Date(Date.UTC(2026, 2, 29, 1, 0, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });

    test("spring forward: first moment outside DND after spring forward", () => {
      // 2026-03-29T05:00:00 UTC = 07:00 CEST (after spring forward, UTC+2)
      // DND 22:00-07:00: 07:00 CEST is at the end boundary (exclusive) -> outside DND
      const utcDate = new Date(Date.UTC(2026, 2, 29, 5, 0, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(false);
    });

    test("fall back: Berlin CEST to CET transition (last Sunday of October)", () => {
      // 2026-10-25 is the last Sunday of October 2026.
      // At 03:00 CEST, clocks fall back to 02:00 CET.
      // 2026-10-25T00:30:00 UTC = 02:30 CEST (before transition, UTC+2)
      // DND 22:00-07:00: 02:30 is inside DND
      const utcDate = new Date(Date.UTC(2026, 9, 25, 0, 30, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });

    test("fall back: after transition clocks go from CEST to CET", () => {
      // 2026-10-25T02:00:00 UTC = 03:00 CET (after fall back, UTC+1)
      // DND 22:00-07:00: 03:00 CET is inside DND
      const utcDate = new Date(Date.UTC(2026, 9, 25, 2, 0, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });

    test("fall back: DND ends correctly after fall back", () => {
      // 2026-10-25T06:00:00 UTC = 07:00 CET (after fall back, UTC+1)
      // DND 22:00-07:00: 07:00 CET is at end boundary (exclusive) -> outside DND
      const utcDate = new Date(Date.UTC(2026, 9, 25, 6, 0, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(false);
    });

    test("NYC spring forward: March DST transition", () => {
      // 2026-03-08 is the second Sunday of March 2026 (US spring forward).
      // At 02:00 EST, clocks spring forward to 03:00 EDT.
      // 2026-03-08T06:30:00 UTC = 01:30 EST (before transition, UTC-5)
      // DND 22:00-07:00: 01:30 is inside DND
      const utcDate = new Date(Date.UTC(2026, 2, 8, 6, 30, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "America/New_York" };
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });

    test("NYC spring forward: just after transition", () => {
      // 2026-03-08T07:00:00 UTC = 03:00 EDT (after spring forward, UTC-4)
      // DND 22:00-07:00: 03:00 is inside DND
      const utcDate = new Date(Date.UTC(2026, 2, 8, 7, 0, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "America/New_York" };
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });
  });

  // ---- Boundary precision with minutes ------------------------------------

  describe("minute-level boundary precision with timezone", () => {
    test("active at 22:01 Berlin time", () => {
      // 2026-01-15T21:01:00 UTC = 22:01 Berlin (CET, UTC+1) -> inside DND
      const utcDate = new Date(Date.UTC(2026, 0, 15, 21, 1, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });

    test("active at 06:59 Berlin time", () => {
      // 2026-01-16T05:59:00 UTC = 06:59 Berlin (CET, UTC+1) -> inside DND
      const utcDate = new Date(Date.UTC(2026, 0, 16, 5, 59, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });

    test("inactive at 07:01 Berlin time", () => {
      // 2026-01-16T06:01:00 UTC = 07:01 Berlin (CET, UTC+1) -> outside DND
      const utcDate = new Date(Date.UTC(2026, 0, 16, 6, 1, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(false);
    });

    test("inactive at 21:59 Berlin time", () => {
      // 2026-01-15T20:59:00 UTC = 21:59 Berlin (CET, UTC+1) -> outside DND
      const utcDate = new Date(Date.UTC(2026, 0, 15, 20, 59, 0));
      const schedule = { start: "22:00", end: "07:00", timezone: "Europe/Berlin" };
      expect(isDndActive(schedule, () => utcDate)).toBe(false);
    });
  });

  // ---- Same-day DND window with timezone ----------------------------------

  describe("same-day DND window with timezone", () => {
    const schedule = { start: "09:00", end: "17:00", timezone: "Europe/Berlin" };

    test("active at 12:00 Berlin time (same-day window)", () => {
      // 2026-01-15T11:00:00 UTC = 12:00 Berlin (CET) -> inside 09:00-17:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 11, 0, 0));
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });

    test("inactive at 08:00 Berlin time (before same-day window start)", () => {
      // 2026-01-15T07:00:00 UTC = 08:00 Berlin (CET) -> before 09:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 7, 0, 0));
      expect(isDndActive(schedule, () => utcDate)).toBe(false);
    });

    test("active at exactly 09:00 Berlin time (start is inclusive)", () => {
      // 2026-01-15T08:00:00 UTC = 09:00 Berlin (CET) -> start boundary
      const utcDate = new Date(Date.UTC(2026, 0, 15, 8, 0, 0));
      expect(isDndActive(schedule, () => utcDate)).toBe(true);
    });

    test("inactive at exactly 17:00 Berlin time (end is exclusive)", () => {
      // 2026-01-15T16:00:00 UTC = 17:00 Berlin (CET) -> end boundary, exclusive
      const utcDate = new Date(Date.UTC(2026, 0, 15, 16, 0, 0));
      expect(isDndActive(schedule, () => utcDate)).toBe(false);
    });

    test("inactive at 20:00 Berlin time (after same-day window)", () => {
      // 2026-01-15T19:00:00 UTC = 20:00 Berlin (CET) -> after 17:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 19, 0, 0));
      expect(isDndActive(schedule, () => utcDate)).toBe(false);
    });
  });

  // ---- Positive UTC offset (Asia) ----------------------------------------

  describe("Asia/Tokyo timezone (JST, always UTC+9, no DST)", () => {
    const tokyoSchedule = { start: "23:00", end: "06:00", timezone: "Asia/Tokyo" };

    test("active at 01:00 Tokyo time", () => {
      // 2026-01-15T16:00:00 UTC = 01:00 JST (Jan 16) -> inside 23:00-06:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 16, 0, 0));
      expect(isDndActive(tokyoSchedule, () => utcDate)).toBe(true);
    });

    test("inactive at 12:00 Tokyo time", () => {
      // 2026-01-15T03:00:00 UTC = 12:00 JST -> outside 23:00-06:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 3, 0, 0));
      expect(isDndActive(tokyoSchedule, () => utcDate)).toBe(false);
    });

    test("active at exactly 23:00 Tokyo time (start inclusive)", () => {
      // 2026-01-15T14:00:00 UTC = 23:00 JST -> start boundary, inclusive
      const utcDate = new Date(Date.UTC(2026, 0, 15, 14, 0, 0));
      expect(isDndActive(tokyoSchedule, () => utcDate)).toBe(true);
    });

    test("inactive at exactly 06:00 Tokyo time (end exclusive)", () => {
      // 2026-01-15T21:00:00 UTC = 06:00 JST (Jan 16) -> end boundary, exclusive
      const utcDate = new Date(Date.UTC(2026, 0, 15, 21, 0, 0));
      expect(isDndActive(tokyoSchedule, () => utcDate)).toBe(false);
    });
  });

  // ---- Negative half-hour UTC offset (e.g. Newfoundland) ------------------

  describe("America/St_Johns timezone (NST, UTC-3:30)", () => {
    const nfldSchedule = { start: "22:00", end: "07:00", timezone: "America/St_Johns" };

    test("active at 23:15 Newfoundland time", () => {
      // NST is UTC-3:30. 23:15 NST = 02:45 UTC (next day)
      // 2026-01-16T02:45:00 UTC = 23:15 NST (Jan 15) -> inside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 0, 16, 2, 45, 0));
      expect(isDndActive(nfldSchedule, () => utcDate)).toBe(true);
    });

    test("inactive at 12:00 Newfoundland time", () => {
      // 12:00 NST = 15:30 UTC
      // 2026-01-15T15:30:00 UTC = 12:00 NST -> outside 22:00-07:00
      const utcDate = new Date(Date.UTC(2026, 0, 15, 15, 30, 0));
      expect(isDndActive(nfldSchedule, () => utcDate)).toBe(false);
    });
  });

  // ---- Invalid timezone fallback ------------------------------------------

  describe("invalid timezone graceful fallback", () => {
    test("does not throw for unknown IANA timezone", () => {
      const schedule = { start: "22:00", end: "07:00", timezone: "Mars/Olympus_Mons" };
      // Should fall back to local time and not crash
      expect(() => isDndActive(schedule, () => new Date(2026, 0, 1, 14, 0))).not.toThrow();
    });

    test("does not throw for empty timezone string", () => {
      const schedule = { start: "22:00", end: "07:00", timezone: "" };
      // Empty string may throw from Intl -- should fall back gracefully
      expect(() => isDndActive(schedule, () => new Date(2026, 0, 1, 14, 0))).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// MessageRouter timezone-aware DND integration tests
// ---------------------------------------------------------------------------

describe("MessageRouter timezone-aware DND integration", () => {
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

  test("suppresses normal notification during DND in Europe/Berlin timezone", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    // UTC 22:30 = 23:30 Berlin (CET) -> inside DND 22:00-07:00
    const utcDate = new Date(Date.UTC(2026, 0, 15, 22, 30, 0));
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00", timezone: "Europe/Berlin" },
      nowProvider: () => utcDate,
    });
    const channel = createMockChannel("telegram");
    router.registerChannel(channel);

    const result = await router.sendNotification(
      { id: "tz-1", channelId: "telegram", text: "Discovery notification" },
      "normal",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(false);
    expect(channel.sentMessages).toHaveLength(0);
  });

  test("allows normal notification outside DND in Europe/Berlin timezone", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    // UTC 09:00 = 10:00 Berlin (CET) -> outside DND 22:00-07:00
    const utcDate = new Date(Date.UTC(2026, 0, 15, 9, 0, 0));
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00", timezone: "Europe/Berlin" },
      nowProvider: () => utcDate,
    });
    const channel = createMockChannel("telegram");
    router.registerChannel(channel);

    const result = await router.sendNotification(
      { id: "tz-2", channelId: "telegram", text: "Discovery notification" },
      "normal",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
    expect(channel.sentMessages).toHaveLength(1);
  });

  test("critical notification bypasses timezone-aware DND", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    // UTC 22:30 = 23:30 Berlin (CET) -> inside DND
    const utcDate = new Date(Date.UTC(2026, 0, 15, 22, 30, 0));
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00", timezone: "Europe/Berlin" },
      nowProvider: () => utcDate,
    });
    const channel = createMockChannel("telegram");
    router.registerChannel(channel);

    const result = await router.sendNotification(
      { id: "tz-3", channelId: "telegram", text: "Security alert" },
      "critical",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(true);
    expect(channel.sentMessages).toHaveLength(1);
  });

  test("DND evaluation differs for same UTC time in different timezones", async () => {
    // UTC 21:30 = 22:30 Berlin (inside DND) but 16:30 NYC (outside DND)
    const utcDate = new Date(Date.UTC(2026, 0, 15, 21, 30, 0));

    // Berlin: should suppress
    const db1 = makeDb();
    const bus1 = new EventBus(db1, logger);
    const berlinRouter = new MessageRouter(bus1, logger, {
      dndSchedule: { start: "22:00", end: "07:00", timezone: "Europe/Berlin" },
      nowProvider: () => utcDate,
    });
    const berlinChannel = createMockChannel("telegram");
    berlinRouter.registerChannel(berlinChannel);

    const berlinResult = await berlinRouter.sendNotification(
      { id: "tz-4a", channelId: "telegram", text: "Test" },
      "normal",
    );
    expect(berlinResult.ok).toBe(true);
    if (berlinResult.ok) expect(berlinResult.value).toBe(false); // suppressed

    // NYC: should send
    const db2 = makeDb();
    const bus2 = new EventBus(db2, logger);
    const nycRouter = new MessageRouter(bus2, logger, {
      dndSchedule: { start: "22:00", end: "07:00", timezone: "America/New_York" },
      nowProvider: () => utcDate,
    });
    const nycChannel = createMockChannel("telegram");
    nycRouter.registerChannel(nycChannel);

    const nycResult = await nycRouter.sendNotification({ id: "tz-4b", channelId: "telegram", text: "Test" }, "normal");
    expect(nycResult.ok).toBe(true);
    if (nycResult.ok) expect(nycResult.value).toBe(true); // sent
    expect(nycChannel.sentMessages).toHaveLength(1);
  });

  test("DST transition does not break DND enforcement", async () => {
    const db = makeDb();
    const bus = new EventBus(db, logger);
    // 2026-03-29T01:00:00 UTC = 03:00 CEST (after spring forward) -> inside DND
    const utcDate = new Date(Date.UTC(2026, 2, 29, 1, 0, 0));
    const router = new MessageRouter(bus, logger, {
      dndSchedule: { start: "22:00", end: "07:00", timezone: "Europe/Berlin" },
      nowProvider: () => utcDate,
    });
    const channel = createMockChannel("telegram");
    router.registerChannel(channel);

    const result = await router.sendNotification(
      { id: "tz-5", channelId: "telegram", text: "Low priority update" },
      "low",
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(false); // suppressed during DND
    expect(channel.sentMessages).toHaveLength(0);
  });
});
