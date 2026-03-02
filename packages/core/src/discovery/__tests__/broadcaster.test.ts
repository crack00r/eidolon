import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import { DiscoveryBroadcaster, getLocalIpAddresses } from "../broadcaster.ts";
import { TailscaleDetector } from "../tailscale.ts";

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

describe("getLocalIpAddresses", () => {
  test("returns an array of strings", () => {
    const addresses = getLocalIpAddresses();
    expect(Array.isArray(addresses)).toBe(true);
    for (const addr of addresses) {
      expect(typeof addr).toBe("string");
      // Each should be an IPv4 address
      expect(addr).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
  });

  test("does not include loopback", () => {
    const addresses = getLocalIpAddresses();
    expect(addresses).not.toContain("127.0.0.1");
  });
});

describe("DiscoveryBroadcaster", () => {
  const logger = createSilentLogger();

  test("buildBeacon returns valid beacon object", () => {
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
    });

    const beacon = broadcaster.buildBeacon();
    expect(beacon.service).toBe("eidolon");
    expect(beacon.port).toBe(8419);
    expect(beacon.tls).toBe(false);
    expect(beacon.role).toBe("server");
    expect(typeof beacon.hostname).toBe("string");
    expect(typeof beacon.host).toBe("string");
    expect(typeof beacon.version).toBe("string");
    expect(typeof beacon.startedAt).toBe("number");
  });

  test("buildBeacon includes TLS when enabled", () => {
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: true,
    });

    const beacon = broadcaster.buildBeacon();
    expect(beacon.tls).toBe(true);
  });

  test("buildBeacon includes tailscale IP when detector has one", () => {
    const tailscale = new TailscaleDetector(logger);
    // Access private cache for testing
    (tailscale as unknown as Record<string, unknown>).cache = { ip: "100.1.2.3", hostname: "test", active: true };

    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
      tailscale,
    });

    const beacon = broadcaster.buildBeacon();
    expect(beacon.tailscaleIp).toBe("100.1.2.3");
  });

  test("beacon serializes to valid JSON within size limit", () => {
    const broadcaster = new DiscoveryBroadcaster({
      logger,
      gatewayPort: 8419,
      tlsEnabled: false,
    });

    const beacon = broadcaster.buildBeacon();
    const json = JSON.stringify(beacon);
    expect(json.length).toBeLessThan(1024);
    expect(() => JSON.parse(json)).not.toThrow();
  });
});
