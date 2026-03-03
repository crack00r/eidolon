/**
 * Tests for the graceful shutdown sequence in performShutdown() and teardownModules().
 *
 * These tests verify the shutdown steps without calling EidolonDaemon.start(),
 * instead exercising the individual module interactions that shutdown orchestrates.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { BusEvent, Channel, ChannelCapabilities, EidolonError, InboundMessage, OutboundMessage, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { SessionSupervisor } from "../../loop/session-supervisor.ts";
import { MessageRouter } from "../../channels/router.ts";
import { MetricsRegistry } from "../../metrics/prometheus.ts";

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

/** Create an in-memory operational database with all migrations applied. */
function createInMemoryOperationalDb(logger: Logger): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger);
  if (!result.ok) {
    throw new Error(`Failed to run migrations: ${result.error.message}`);
  }
  return db;
}

const TEXT_CAPABILITIES: ChannelCapabilities = {
  text: true,
  markdown: false,
  images: false,
  documents: false,
  voice: false,
  reactions: false,
  editing: false,
  streaming: false,
};

/** Create a fake Channel implementation for testing disconnect behavior. */
function createFakeChannel(
  channelId: string,
  options?: { disconnectThrows?: boolean },
): Channel & { disconnectCalled: boolean; connected: boolean } {
  const state = {
    disconnectCalled: false,
    connected: true,
    id: channelId,
    name: `Fake ${channelId}`,
    capabilities: TEXT_CAPABILITIES,
    async connect(): Promise<Result<void, EidolonError>> {
      state.connected = true;
      return Ok(undefined);
    },
    async disconnect(): Promise<void> {
      state.disconnectCalled = true;
      if (options?.disconnectThrows) {
        throw new Error(`Disconnect error for ${channelId}`);
      }
      state.connected = false;
    },
    async send(_message: OutboundMessage): Promise<Result<void, EidolonError>> {
      return Ok(undefined);
    },
    onMessage(_handler: (message: InboundMessage) => Promise<void>): void {
      // no-op for tests
    },
    isConnected(): boolean {
      return state.connected;
    },
  };
  return state;
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("Graceful shutdown: EventBus dispose", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    databases.length = 0;
  });

  test("EventBus.dispose() prevents subscribers from receiving new events", () => {
    const db = createInMemoryOperationalDb(logger);
    databases.push(db);

    const bus = new EventBus(db, logger);
    const received: BusEvent[] = [];

    bus.subscribe("user:message", (event) => {
      received.push(event);
    });

    // Publish before dispose -- subscriber should receive it
    const pub1 = bus.publish("user:message", { text: "before" });
    expect(pub1.ok).toBe(true);
    expect(received).toHaveLength(1);

    // Dispose subscribers
    bus.dispose();

    // Publish after dispose -- subscriber should NOT receive it
    const pub2 = bus.publish("user:message", { text: "after" });
    expect(pub2.ok).toBe(true);
    expect(received).toHaveLength(1); // still 1, not 2

    // But the event IS persisted in SQLite
    const pending = bus.pendingCount();
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      // Both events persisted, only the first was dequeued in subscriber flow
      expect(pending.value).toBe(2);
    }
  });

  test("EventBus.dispose() is safe to call multiple times", () => {
    const db = createInMemoryOperationalDb(logger);
    databases.push(db);

    const bus = new EventBus(db, logger);
    bus.subscribe("user:message", () => {});

    // Should not throw on repeated calls
    bus.dispose();
    bus.dispose();
    bus.dispose();

    // EventBus still functions for persistence after dispose
    const result = bus.publish("user:message", { text: "still works" });
    expect(result.ok).toBe(true);
  });
});

describe("Graceful shutdown: Session abort", () => {
  const logger = createSilentLogger();

  test("SessionSupervisor tracks sessions that can be iterated and unregistered", () => {
    const supervisor = new SessionSupervisor(logger);

    // Register two sessions
    const reg1 = supervisor.register("sess-1", "main");
    expect(reg1.ok).toBe(true);
    const reg2 = supervisor.register("sess-2", "task");
    expect(reg2.ok).toBe(true);

    expect(supervisor.hasActiveSessions()).toBe(true);
    expect(supervisor.getActive()).toHaveLength(2);

    // Simulate shutdown: iterate and unregister
    const active = supervisor.getActive();
    for (const slot of active) {
      supervisor.unregister(slot.sessionId);
    }

    expect(supervisor.hasActiveSessions()).toBe(false);
    expect(supervisor.getActive()).toHaveLength(0);
  });

  test("Unregistering a non-existent session does not throw", () => {
    const supervisor = new SessionSupervisor(logger);

    // Should not throw
    supervisor.unregister("does-not-exist");
    expect(supervisor.hasActiveSessions()).toBe(false);
  });
});

describe("Graceful shutdown: Channel disconnect", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    databases.length = 0;
  });

  test("MessageRouter.getChannels() returns registered channels for disconnect", () => {
    const db = createInMemoryOperationalDb(logger);
    databases.push(db);

    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger);

    const channel1 = createFakeChannel("test-ch-1");
    const channel2 = createFakeChannel("test-ch-2");

    router.registerChannel(channel1);
    router.registerChannel(channel2);

    const channels = router.getChannels();
    expect(channels).toHaveLength(2);

    // Simulate shutdown disconnect
    for (const channel of channels) {
      if (channel.isConnected()) {
        // In real code this would be awaited
        void channel.disconnect();
      }
    }

    expect(channel1.disconnectCalled).toBe(true);
    expect(channel1.connected).toBe(false);
    expect(channel2.disconnectCalled).toBe(true);
    expect(channel2.connected).toBe(false);
  });

  test("Channel disconnect error does not prevent other channels from disconnecting", async () => {
    const db = createInMemoryOperationalDb(logger);
    databases.push(db);

    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger);

    // First channel throws on disconnect, second should still disconnect
    const failChannel = createFakeChannel("fail-ch", { disconnectThrows: true });
    const okChannel = createFakeChannel("ok-ch");

    router.registerChannel(failChannel);
    router.registerChannel(okChannel);

    const channels = router.getChannels();
    for (const channel of channels) {
      try {
        if (channel.isConnected()) {
          await channel.disconnect();
        }
      } catch {
        // Swallow error like performShutdown does
      }
    }

    expect(failChannel.disconnectCalled).toBe(true);
    // failChannel is still "connected" because disconnect threw before setting connected=false
    expect(failChannel.connected).toBe(true);

    expect(okChannel.disconnectCalled).toBe(true);
    expect(okChannel.connected).toBe(false);
  });

  test("Already disconnected channels are skipped", async () => {
    const db = createInMemoryOperationalDb(logger);
    databases.push(db);

    const bus = new EventBus(db, logger);
    const router = new MessageRouter(bus, logger);

    const channel = createFakeChannel("pre-disconnected");
    channel.connected = false; // Already disconnected

    router.registerChannel(channel);

    const channels = router.getChannels();
    for (const ch of channels) {
      if (ch.isConnected()) {
        await ch.disconnect();
      }
    }

    // disconnect() should NOT have been called since isConnected() returned false
    expect(channel.disconnectCalled).toBe(false);
  });
});

describe("Graceful shutdown: Metrics snapshot", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    databases.length = 0;
  });

  test("Final metrics snapshot captures event queue depth and active session count", () => {
    const db = createInMemoryOperationalDb(logger);
    databases.push(db);

    const bus = new EventBus(db, logger);
    const supervisor = new SessionSupervisor(logger);
    const registry = new MetricsRegistry();

    // Set up some state: 3 pending events, 2 active sessions
    bus.publish("user:message", { text: "event-1" });
    bus.publish("system:startup", { pid: 1 });
    bus.publish("user:message", { text: "event-2" });

    supervisor.register("sess-a", "main");
    supervisor.register("sess-b", "task");

    // Simulate step 4 of performShutdown: capture final metrics
    const pendingResult = bus.pendingCount();
    if (pendingResult.ok) {
      registry.setEventQueueDepth(pendingResult.value);
    }
    registry.setActiveSessions(supervisor.getActive().length);

    // Verify metrics reflect the state
    expect(registry.eventQueueDepth.values.get("")).toBe(3);
    expect(registry.activeSessions.values.get("")).toBe(2);
  });
});

describe("Graceful shutdown: system:shutdown event persistence", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    databases.length = 0;
  });

  test("system:shutdown event persists to SQLite even after dispose", () => {
    const db = createInMemoryOperationalDb(logger);
    databases.push(db);

    const bus = new EventBus(db, logger);

    // Simulate steps 1 and 5: dispose subscribers first, then publish shutdown
    bus.dispose();

    const result = bus.publish("system:shutdown", { reason: "graceful" }, {
      priority: "critical",
      source: "daemon",
    });
    expect(result.ok).toBe(true);

    // The event should be in SQLite despite no subscribers
    const deqResult = bus.dequeue();
    expect(deqResult.ok).toBe(true);
    if (deqResult.ok && deqResult.value) {
      expect(deqResult.value.type).toBe("system:shutdown");
      expect(deqResult.value.priority).toBe("critical");
      expect(deqResult.value.source).toBe("daemon");
      expect(deqResult.value.payload).toEqual({ reason: "graceful" });
    } else {
      throw new Error("Expected system:shutdown event to be dequeued");
    }
  });
});

describe("teardownModules: safety net for startup-failure path", () => {
  const logger = createSilentLogger();
  const databases: Database[] = [];

  afterEach(() => {
    for (const db of databases) {
      try {
        db.close();
      } catch {
        // already closed
      }
    }
    databases.length = 0;
  });

  test("EventBus dispose works in teardownModules when performShutdown was not called", () => {
    const db = createInMemoryOperationalDb(logger);
    databases.push(db);

    const bus = new EventBus(db, logger);
    const received: BusEvent[] = [];
    bus.subscribe("user:message", (event) => {
      received.push(event);
    });

    // Simulate teardownModules calling dispose (safety net)
    bus.dispose();

    // Verify subscribers cleared
    bus.publish("user:message", { text: "should not be received" });
    expect(received).toHaveLength(0);
  });

  test("SessionSupervisor cleanup in teardownModules handles active sessions", () => {
    const supervisor = new SessionSupervisor(logger);

    // Register sessions as if startup partially succeeded
    supervisor.register("sess-startup-1", "task");
    supervisor.register("sess-startup-2", "learning");

    expect(supervisor.hasActiveSessions()).toBe(true);

    // Simulate teardownModules cleanup
    const remaining = supervisor.getActive();
    for (const slot of remaining) {
      supervisor.unregister(slot.sessionId);
    }

    expect(supervisor.hasActiveSessions()).toBe(false);
    expect(supervisor.getActive()).toHaveLength(0);
  });
});
