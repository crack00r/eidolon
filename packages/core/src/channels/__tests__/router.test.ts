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

  test("cross-midnight window inactive at 14:00", () => {
    const schedule = { start: "22:00", end: "07:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 14, 0));
    expect(active).toBe(false);
  });

  test("same-day window active at 12:00", () => {
    const schedule = { start: "09:00", end: "17:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 12, 0));
    expect(active).toBe(true);
  });

  test("same-day window inactive at 20:00", () => {
    const schedule = { start: "09:00", end: "17:00" };
    const active = isDndActive(schedule, () => new Date(2026, 0, 1, 20, 0));
    expect(active).toBe(false);
  });
});
