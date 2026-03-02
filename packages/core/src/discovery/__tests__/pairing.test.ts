import { describe, expect, test } from "bun:test";
import type { GatewayConfig } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { buildPairingUrl, formatConnectionDetails, generateAuthToken } from "../pairing.ts";
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

function makeGatewayConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    host: "0.0.0.0",
    port: 8419,
    tls: { enabled: false },
    maxMessageBytes: 1_048_576,
    maxClients: 10,
    allowedOrigins: [],
    rateLimiting: { maxFailures: 5, windowMs: 60_000, blockMs: 300_000, maxBlockMs: 3_600_000 },
    auth: { type: "token", token: "test-secret-token" },
    ...overrides,
  } as GatewayConfig;
}

describe("generateAuthToken", () => {
  test("generates URL-safe base64 string", () => {
    const token = generateAuthToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(20);
    // URL-safe base64 should not contain +, /, or =
    expect(token).not.toMatch(/[+/=]/);
  });

  test("generates unique tokens", () => {
    const tokens = new Set(Array.from({ length: 10 }, () => generateAuthToken()));
    expect(tokens.size).toBe(10);
  });
});

describe("buildPairingUrl", () => {
  test("builds eidolon:// URL with token and tls params", () => {
    const config = makeGatewayConfig();
    const pairing = buildPairingUrl(config);

    expect(pairing.url).toMatch(/^eidolon:\/\//);
    expect(pairing.url).toContain("token=test-secret-token");
    expect(pairing.url).toContain("tls=false");
    expect(pairing.port).toBe(8419);
    expect(pairing.token).toBe("test-secret-token");
    expect(pairing.tls).toBe(false);
  });

  test("reflects TLS enabled in URL", () => {
    const config = makeGatewayConfig({ tls: { enabled: true, cert: "/c", key: "/k" } });
    const pairing = buildPairingUrl(config);
    expect(pairing.tls).toBe(true);
    expect(pairing.url).toContain("tls=true");
  });

  test("includes tailscale IP when available", () => {
    const logger = createSilentLogger();
    const tailscale = new TailscaleDetector(logger);
    (tailscale as unknown as Record<string, unknown>).cache = { ip: "100.1.2.3", hostname: "test", active: true };

    const config = makeGatewayConfig();
    const pairing = buildPairingUrl(config, tailscale);
    expect(pairing.tailscaleIp).toBe("100.1.2.3");
    expect(pairing.url).toContain("tailscale=100.1.2.3");
  });

  test("uses specific host when not wildcard", () => {
    const config = makeGatewayConfig({ host: "192.168.1.50" });
    const pairing = buildPairingUrl(config);
    expect(pairing.host).toBe("192.168.1.50");
  });
});

describe("formatConnectionDetails", () => {
  test("returns formatted string with host and port", () => {
    const config = makeGatewayConfig();
    const details = formatConnectionDetails(config);
    expect(details).toContain("8419");
    expect(details).toContain("disabled");
    expect(details).toContain("eidolon://");
  });
});
