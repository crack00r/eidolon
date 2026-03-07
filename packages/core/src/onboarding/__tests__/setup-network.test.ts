import { describe, expect, test } from "bun:test";
import { buildGatewayConfig, generateAuthToken } from "../setup-network.ts";

describe("generateAuthToken", () => {
  test("returns a 64-character hex string", () => {
    const token = generateAuthToken();
    expect(token).toHaveLength(64);
    expect(/^[0-9a-f]{64}$/.test(token)).toBe(true);
  });

  test("generates unique tokens on each call", () => {
    const t1 = generateAuthToken();
    const t2 = generateAuthToken();
    expect(t1).not.toBe(t2);
  });
});

describe("buildGatewayConfig", () => {
  test("binds to localhost when no tailscale IP", () => {
    const config = buildGatewayConfig({
      port: 8080,
      token: "abc123",
      tailscaleIp: undefined,
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.auth.type).toBe("token");
    expect(config.auth.token).toBe("abc123");
    expect(config.tls.enabled).toBe(false);
    expect(config.discovery.enabled).toBe(false);
  });

  test("binds to 0.0.0.0 with tailscale IP and enables discovery", () => {
    const config = buildGatewayConfig({
      port: 9090,
      token: "xyz789",
      tailscaleIp: "100.64.0.1",
    });

    expect(config.host).toBe("0.0.0.0");
    expect(config.discovery.enabled).toBe(true);
    expect(config.discovery.port).toBe(41920);
  });
});
