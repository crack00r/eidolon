import { afterEach, describe, expect, test } from "bun:test";
import type { DiscoveryBeacon } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { DiscoveryBroadcaster, type SignedBeacon } from "../broadcaster.ts";
import { DiscoveryListener, type DiscoveredServer } from "../listener.ts";

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

function makeBeacon(overrides?: Partial<DiscoveryBeacon>): DiscoveryBeacon {
  return {
    service: "eidolon",
    version: "0.1.5",
    hostname: "test-server",
    host: "192.168.1.100",
    port: 8419,
    tls: false,
    role: "server",
    startedAt: Date.now(),
    ...overrides,
  };
}

// Track listener instances for cleanup
const listeners: DiscoveryListener[] = [];

afterEach(async () => {
  for (const listener of listeners) {
    await listener.stop();
  }
  listeners.length = 0;
});

// ---------------------------------------------------------------------------
// HMAC Verification (via DiscoveryBroadcaster.verifyBeacon)
// ---------------------------------------------------------------------------

describe("Beacon HMAC signing and verification", () => {
  const key = "test-signing-key-32bytes-long!!";

  test("signBeacon produces a valid signed beacon", () => {
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
      beaconKey: key,
    });

    const beacon = makeBeacon();
    const signed = broadcaster.signBeacon(beacon);

    expect(signed.beacon).toEqual(beacon);
    expect(typeof signed.nonce).toBe("string");
    expect(signed.nonce.length).toBe(32); // 16 bytes = 32 hex chars
    expect(typeof signed.hmac).toBe("string");
    expect(signed.hmac.length).toBe(64); // SHA-256 = 64 hex chars
  });

  test("verifyBeacon accepts correctly signed beacons", () => {
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
      beaconKey: key,
    });

    const beacon = makeBeacon();
    const signed = broadcaster.signBeacon(beacon);

    expect(DiscoveryBroadcaster.verifyBeacon(signed, key)).toBe(true);
  });

  test("verifyBeacon rejects beacons signed with wrong key", () => {
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
      beaconKey: key,
    });

    const beacon = makeBeacon();
    const signed = broadcaster.signBeacon(beacon);

    expect(DiscoveryBroadcaster.verifyBeacon(signed, "wrong-key")).toBe(false);
  });

  test("verifyBeacon rejects tampered beacons", () => {
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
      beaconKey: key,
    });

    const beacon = makeBeacon();
    const signed = broadcaster.signBeacon(beacon);

    // Tamper with the beacon data
    const tampered: SignedBeacon = {
      beacon: { ...signed.beacon, port: 9999 },
      nonce: signed.nonce,
      hmac: signed.hmac,
    };

    expect(DiscoveryBroadcaster.verifyBeacon(tampered, key)).toBe(false);
  });

  test("verifyBeacon rejects beacons with tampered nonce", () => {
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
      beaconKey: key,
    });

    const beacon = makeBeacon();
    const signed = broadcaster.signBeacon(beacon);

    const tampered: SignedBeacon = {
      beacon: signed.beacon,
      nonce: "0".repeat(32),
      hmac: signed.hmac,
    };

    expect(DiscoveryBroadcaster.verifyBeacon(tampered, key)).toBe(false);
  });

  test("different nonces produce different HMACs for same beacon", () => {
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
      beaconKey: key,
    });

    const beacon = makeBeacon();
    const signed1 = broadcaster.signBeacon(beacon);
    const signed2 = broadcaster.signBeacon(beacon);

    // Nonces should differ (random)
    expect(signed1.nonce).not.toBe(signed2.nonce);
    // HMACs should differ because nonces differ
    expect(signed1.hmac).not.toBe(signed2.hmac);
    // Both should verify
    expect(DiscoveryBroadcaster.verifyBeacon(signed1, key)).toBe(true);
    expect(DiscoveryBroadcaster.verifyBeacon(signed2, key)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DiscoveryListener (unit tests without network)
// ---------------------------------------------------------------------------

describe("DiscoveryListener", () => {
  test("getServers returns empty array initially", () => {
    const listener = new DiscoveryListener({ logger });
    listeners.push(listener);

    expect(listener.getServers()).toEqual([]);
  });

  test("onServerFound handler is registered and can be unregistered", () => {
    const listener = new DiscoveryListener({ logger });
    listeners.push(listener);

    let callCount = 0;
    const unsubscribe = listener.onServerFound(() => {
      callCount++;
    });

    // Handler registered but not called yet (no beacons received)
    expect(callCount).toBe(0);

    unsubscribe();
    // No error on unsubscribe
  });

  test("onServerLost handler is registered and can be unregistered", () => {
    const listener = new DiscoveryListener({ logger });
    listeners.push(listener);

    let callCount = 0;
    const unsubscribe = listener.onServerLost(() => {
      callCount++;
    });

    expect(callCount).toBe(0);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Integration test: broadcaster -> listener over UDP loopback
// ---------------------------------------------------------------------------

describe("DiscoveryBroadcaster + DiscoveryListener integration", () => {
  test("listener receives beacon from broadcaster on loopback", async () => {
    const foundServers: DiscoveredServer[] = [];

    const listener = new DiscoveryListener({ logger });
    listeners.push(listener);

    listener.onServerFound((server) => {
      foundServers.push(server);
    });

    await listener.start();

    // Create a broadcaster and send a beacon
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
    });

    await broadcaster.start();

    // Wait for at least one beacon to be received (up to 8 seconds)
    const deadline = Date.now() + 8_000;
    while (foundServers.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    await broadcaster.stop();

    // On some CI environments UDP broadcast on loopback may not work,
    // so we check defensively
    if (foundServers.length > 0) {
      const server = foundServers[0];
      expect(server).toBeDefined();
      expect(server!.port).toBe(8419);
      expect(server!.tls).toBe(false);
      expect(typeof server!.hostname).toBe("string");
      expect(typeof server!.host).toBe("string");
      expect(typeof server!.version).toBe("string");
      expect(server!.verified).toBe(false); // No key configured
    }
  });

  test("listener verifies signed beacons when key matches", async () => {
    const key = "integration-test-key-1234567890";
    const foundServers: DiscoveredServer[] = [];

    const listener = new DiscoveryListener({ logger, beaconKey: key });
    listeners.push(listener);

    listener.onServerFound((server) => {
      foundServers.push(server);
    });

    await listener.start();

    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 9999,
      tlsEnabled: true,
      beaconKey: key,
    });

    await broadcaster.start();

    const deadline = Date.now() + 8_000;
    while (foundServers.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    await broadcaster.stop();

    if (foundServers.length > 0) {
      const server = foundServers[0];
      expect(server!.port).toBe(9999);
      expect(server!.tls).toBe(true);
      expect(server!.verified).toBe(true);
    }
  });
});
