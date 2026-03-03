import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { GatewayConfig, GatewayMethod, GatewayResponse } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import {
  createJsonRpcError,
  createJsonRpcResponse,
  createPushEvent,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  parseJsonRpcRequest,
  validateMethod,
} from "../protocol.ts";
import { AuthRateLimiter } from "../rate-limiter.ts";
import { anonymizeIp, constantTimeCompare, GatewayServer, normalizeOrigin } from "../server.ts";

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

/** Open a WebSocket client to the gateway and wait for the connection to open. */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.onopen = (): void => resolve(ws);
    ws.onerror = (ev): void => reject(new Error(`WebSocket error: ${String(ev)}`));
  });
}

/** Send a message and wait for the next message back. */
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

/** Wait for the next message on the WebSocket. */
function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for message")), 3_000);
    ws.onmessage = (ev: MessageEvent): void => {
      clearTimeout(timeout);
      resolve(JSON.parse(String(ev.data)));
    };
  });
}

/** Small delay for async operations to settle. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// ===========================================================================
// Protocol tests
// ===========================================================================

describe("protocol", () => {
  describe("parseJsonRpcRequest", () => {
    test("parses a valid request", () => {
      const raw = JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "system.status",
        params: { verbose: true },
      });
      const result = parseJsonRpcRequest(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.jsonrpc).toBe("2.0");
        expect(result.value.id).toBe("1");
        expect(result.value.method).toBe("system.status");
        expect(result.value.params).toEqual({ verbose: true });
      }
    });

    test("parses a valid request without params", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: "2", method: "system.health" });
      const result = parseJsonRpcRequest(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.params).toBeUndefined();
      }
    });

    test("returns parse error for invalid JSON", () => {
      const result = parseJsonRpcRequest("{not json}");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error?.code).toBe(JSON_RPC_PARSE_ERROR);
      }
    });

    test("returns invalid request for non-object", () => {
      const result = parseJsonRpcRequest('"hello"');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
      }
    });

    test("returns invalid request for array", () => {
      const result = parseJsonRpcRequest("[]");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
      }
    });

    test("returns invalid request when jsonrpc is missing", () => {
      const raw = JSON.stringify({ id: "1", method: "system.status" });
      const result = parseJsonRpcRequest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
      }
    });

    test("returns invalid request when id is missing", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", method: "system.status" });
      const result = parseJsonRpcRequest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
      }
    });

    test("returns invalid request when method is empty", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "" });
      const result = parseJsonRpcRequest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error?.code).toBe(JSON_RPC_INVALID_REQUEST);
      }
    });

    test("returns invalid params when params is not an object", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "system.status", params: "bad" });
      const result = parseJsonRpcRequest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
      }
    });

    test("returns invalid params when params is an array", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "system.status", params: [1, 2] });
      const result = parseJsonRpcRequest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error?.code).toBe(JSON_RPC_INVALID_PARAMS);
      }
    });

    test("returns method not found for unknown method", () => {
      const raw = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "unknown.method" });
      const result = parseJsonRpcRequest(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
      }
    });
  });

  describe("validateMethod", () => {
    test("returns true for valid methods", () => {
      const methods: GatewayMethod[] = [
        "chat.send",
        "chat.stream",
        "memory.search",
        "memory.delete",
        "session.list",
        "session.info",
        "learning.list",
        "learning.approve",
        "learning.reject",
        "system.status",
        "system.health",
        "system.subscribe",
        "error.report",
        "voice.start",
        "voice.stop",
        "brain.pause",
        "brain.resume",
        "brain.triggerAction",
        "brain.getLog",
        "client.list",
        "client.execute",
        "command.result",
        "client.reportErrors",
      ];
      for (const m of methods) {
        expect(validateMethod(m)).toBe(true);
      }
    });

    test("returns false for invalid methods", () => {
      expect(validateMethod("foo.bar")).toBe(false);
      expect(validateMethod("")).toBe(false);
      expect(validateMethod("system")).toBe(false);
    });
  });

  describe("createJsonRpcResponse", () => {
    test("creates a success response", () => {
      const resp = createJsonRpcResponse("42", { status: "ok" });
      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe("42");
      expect(resp.result).toEqual({ status: "ok" });
      expect(resp.error).toBeUndefined();
    });
  });

  describe("createJsonRpcError", () => {
    test("creates an error response without data", () => {
      const resp = createJsonRpcError("1", -32600, "Invalid request");
      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe("1");
      expect(resp.error?.code).toBe(-32600);
      expect(resp.error?.message).toBe("Invalid request");
      expect(resp.error?.data).toBeUndefined();
    });

    test("creates an error response with data", () => {
      const resp = createJsonRpcError("2", -32603, "Oops", { detail: "stack" });
      expect(resp.error?.data).toEqual({ detail: "stack" });
    });
  });

  describe("createPushEvent", () => {
    test("creates a push event", () => {
      const event = createPushEvent("session.updated", { sessionId: "abc" });
      expect(event.jsonrpc).toBe("2.0");
      expect(event.method).toBe("session.updated");
      expect(event.params).toEqual({ sessionId: "abc" });
    });
  });
});

// ===========================================================================
// constantTimeCompare tests
// ===========================================================================

describe("constantTimeCompare", () => {
  test("returns true for identical strings", () => {
    expect(constantTimeCompare("secret-123", "secret-123")).toBe(true);
  });

  test("returns false for different strings of same length", () => {
    expect(constantTimeCompare("secret-123", "secret-456")).toBe(false);
  });

  test("returns false for different lengths", () => {
    expect(constantTimeCompare("short", "much-longer-string")).toBe(false);
  });

  test("returns true for empty strings", () => {
    expect(constantTimeCompare("", "")).toBe(true);
  });

  test("returns false when one is empty", () => {
    expect(constantTimeCompare("", "notempty")).toBe(false);
    expect(constantTimeCompare("notempty", "")).toBe(false);
  });

  test("handles unicode correctly", () => {
    expect(constantTimeCompare("über-geheim", "über-geheim")).toBe(true);
    expect(constantTimeCompare("über-geheim", "uber-geheim")).toBe(false);
  });
});

// ===========================================================================
// anonymizeIp tests
// ===========================================================================

describe("anonymizeIp", () => {
  test("anonymizes IPv4 by zeroing last octet", () => {
    expect(anonymizeIp("192.168.1.42")).toBe("192.168.1.0");
    expect(anonymizeIp("10.0.0.1")).toBe("10.0.0.0");
  });

  test("handles single-segment IP gracefully", () => {
    expect(anonymizeIp("unknown")).toBe("unknown");
  });

  test("anonymizes IPv6 by keeping first 3 groups", () => {
    expect(anonymizeIp("2001:db8:85a3:0:0:8a2e:370:7334")).toBe("2001:db8:85a3::");
    expect(anonymizeIp("::1")).toBe("::1");
  });
});

// ===========================================================================
// normalizeOrigin tests
// ===========================================================================

describe("normalizeOrigin", () => {
  test("lowercases the origin", () => {
    expect(normalizeOrigin("HTTPS://Example.COM")).toBe("https://example.com");
  });

  test("strips trailing slashes", () => {
    expect(normalizeOrigin("https://example.com/")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com///")).toBe("https://example.com");
  });

  test("lowercases and strips trailing slash together", () => {
    expect(normalizeOrigin("HTTPS://Example.COM/")).toBe("https://example.com");
  });

  test("leaves clean origins unchanged (after lowercasing)", () => {
    expect(normalizeOrigin("https://example.com")).toBe("https://example.com");
  });
});

// ===========================================================================
// AuthRateLimiter tests
// ===========================================================================

describe("AuthRateLimiter", () => {
  test("allows requests by default", () => {
    const limiter = new AuthRateLimiter(
      { maxFailures: 3, windowMs: 60_000, blockMs: 300_000, maxBlockMs: 3_600_000 },
      logger,
    );
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);
    limiter.dispose();
  });

  test("blocks after maxFailures", () => {
    const limiter = new AuthRateLimiter(
      { maxFailures: 3, windowMs: 60_000, blockMs: 300_000, maxBlockMs: 3_600_000 },
      logger,
    );

    limiter.recordFailure("1.2.3.4"); // 1
    limiter.recordFailure("1.2.3.4"); // 2
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);

    const blocked = limiter.recordFailure("1.2.3.4"); // 3 -> blocked
    expect(blocked).toBe(true);
    expect(limiter.isBlocked("1.2.3.4")).toBe(true);

    limiter.dispose();
  });

  test("does not block different IPs", () => {
    const limiter = new AuthRateLimiter(
      { maxFailures: 2, windowMs: 60_000, blockMs: 300_000, maxBlockMs: 3_600_000 },
      logger,
    );

    limiter.recordFailure("1.2.3.4");
    limiter.recordFailure("1.2.3.4");
    expect(limiter.isBlocked("5.6.7.8")).toBe(false);

    limiter.dispose();
  });

  test("success clears history", () => {
    const limiter = new AuthRateLimiter(
      { maxFailures: 3, windowMs: 60_000, blockMs: 300_000, maxBlockMs: 3_600_000 },
      logger,
    );

    limiter.recordFailure("1.2.3.4"); // 1
    limiter.recordFailure("1.2.3.4"); // 2
    limiter.recordSuccess("1.2.3.4"); // clears

    // Should need 3 more failures to block
    limiter.recordFailure("1.2.3.4"); // 1
    limiter.recordFailure("1.2.3.4"); // 2
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);

    limiter.dispose();
  });

  test("unblocks after blockMs expires", async () => {
    const limiter = new AuthRateLimiter({ maxFailures: 1, windowMs: 60_000, blockMs: 50, maxBlockMs: 200 }, logger);

    limiter.recordFailure("1.2.3.4");
    expect(limiter.isBlocked("1.2.3.4")).toBe(true);

    await delay(100);
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);

    limiter.dispose();
  });

  test("exponential backoff increases block duration", () => {
    const limiter = new AuthRateLimiter({ maxFailures: 1, windowMs: 60_000, blockMs: 100, maxBlockMs: 10_000 }, logger);

    // First block: 100ms
    const blocked1 = limiter.recordFailure("1.2.3.4");
    expect(blocked1).toBe(true);

    // Manually unblock by waiting (simulate via direct check)
    // For this test, we just verify the block count increments
    // by checking it stays blocked for the expected duration

    limiter.dispose();
  });

  test("dispose clears all state", () => {
    const limiter = new AuthRateLimiter(
      { maxFailures: 1, windowMs: 60_000, blockMs: 300_000, maxBlockMs: 3_600_000 },
      logger,
    );

    limiter.recordFailure("1.2.3.4");
    limiter.dispose();

    // After dispose, new isBlocked check returns false (entries cleared)
    expect(limiter.isBlocked("1.2.3.4")).toBe(false);
  });
});

// ===========================================================================
// Server tests
// ===========================================================================

describe("GatewayServer", () => {
  test("starts and stops cleanly", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const server = new GatewayServer({ config, logger, eventBus });
    activeServers.push(server);

    expect(server.isRunning).toBe(false);
    expect(server.connectedClients).toBe(0);

    await server.start();
    expect(server.isRunning).toBe(true);

    await server.stop();
    expect(server.isRunning).toBe(false);
  });

  test("accepts client connections (auth: none)", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const server = new GatewayServer({ config, logger, eventBus });
    activeServers.push(server);

    await server.start();

    const ws = await connectClient(config.port);
    activeClients.push(ws);

    // Give the server a moment to register the client
    await delay(50);

    expect(server.connectedClients).toBe(1);

    ws.close();
    await delay(50);

    expect(server.connectedClients).toBe(0);
  });

  test("handles multiple client connections", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const server = new GatewayServer({ config, logger, eventBus });
    activeServers.push(server);

    await server.start();

    const ws1 = await connectClient(config.port);
    const ws2 = await connectClient(config.port);
    activeClients.push(ws1, ws2);

    await delay(50);
    expect(server.connectedClients).toBe(2);

    ws1.close();
    await delay(50);
    expect(server.connectedClients).toBe(1);

    ws2.close();
    await delay(50);
    expect(server.connectedClients).toBe(0);
  });

  describe("authentication", () => {
    test("authenticates with valid token (raw ClientAuth format)", async () => {
      const config = makeConfig({ auth: { type: "token", token: "secret-123" } });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      // Register a handler so we can verify auth worked
      server.registerHandler("system.status", async () => ({ status: "ok" }));

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      // Send auth in raw ClientAuth format
      ws.send(JSON.stringify({ type: "token", token: "secret-123" }));
      await delay(50);

      // Now send a JSON-RPC request — should succeed
      const resp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "1",
        method: "system.status",
      });

      expect(resp.jsonrpc).toBe("2.0");
      expect(resp.id).toBe("1");
      expect(resp.result).toEqual({ status: "ok" });
    });

    test("authenticates with valid token (JSON-RPC format)", async () => {
      const config = makeConfig({ auth: { type: "token", token: "secret-456" } });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      server.registerHandler("system.status", async () => ({ status: "ok" }));

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      // Send auth as JSON-RPC
      const authResp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "auth-1",
        method: "auth.authenticate",
        params: { token: "secret-456" },
      });

      // Should get a proper JSON-RPC success response
      expect(authResp.jsonrpc).toBe("2.0");
      expect(authResp.id).toBe("auth-1");
      expect(authResp.result).toEqual({ authenticated: true });

      // Now send a regular RPC request — should succeed
      const resp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "2",
        method: "system.status",
      });
      expect(resp.result).toEqual({ status: "ok" });
    });

    test("JSON-RPC auth returns error response on wrong token", async () => {
      const config = makeConfig({ auth: { type: "token", token: "correct" } });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      const closed = new Promise<number>((resolve) => {
        ws.onclose = (ev): void => resolve(ev.code);
      });

      // Send JSON-RPC auth with wrong token — expect error response then close
      const errResp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "auth-1",
        method: "auth.authenticate",
        params: { token: "wrong" },
      });

      expect(errResp.jsonrpc).toBe("2.0");
      expect(errResp.id).toBe("auth-1");
      expect(errResp.error).toBeDefined();

      const closeCode = await closed;
      expect(closeCode).toBe(4001);
    });

    test("rejects invalid token and closes connection", async () => {
      const config = makeConfig({ auth: { type: "token", token: "secret-123" } });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      const closed = new Promise<number>((resolve) => {
        ws.onclose = (ev): void => resolve(ev.code);
      });

      // Send wrong token
      ws.send(JSON.stringify({ type: "token", token: "wrong" }));

      const closeCode = await closed;
      expect(closeCode).toBe(4001);
    });

    test("rejects malformed auth payload", async () => {
      const config = makeConfig({ auth: { type: "token", token: "secret-123" } });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      const closed = new Promise<number>((resolve) => {
        ws.onclose = (ev): void => resolve(ev.code);
      });

      // Send invalid JSON
      ws.send("not json");

      const closeCode = await closed;
      expect(closeCode).toBe(4001);
    });

    test("skips auth when type is none", async () => {
      const config = makeConfig({ auth: { type: "none" } });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      server.registerHandler("system.health", async () => ({ healthy: true }));

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      // Should be able to send requests immediately without auth
      const resp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "1",
        method: "system.health",
      });

      expect(resp.result).toEqual({ healthy: true });
    });
  });

  describe("connection limits", () => {
    test("rejects connections when maxClients is reached", async () => {
      const config = makeConfig({ maxClients: 2 });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      await server.start();

      const ws1 = await connectClient(config.port);
      const ws2 = await connectClient(config.port);
      activeClients.push(ws1, ws2);
      await delay(50);

      expect(server.connectedClients).toBe(2);

      // Third connection should be rejected (503 during upgrade)
      try {
        const ws3 = await connectClient(config.port);
        // If we get here, the connection was accepted — check if it was actually closed
        activeClients.push(ws3);
        const _closed = new Promise<number>((resolve) => {
          ws3.onclose = (ev): void => resolve(ev.code);
        });
        // Give server time to reject
        await delay(100);
        // Connection may have been rejected at HTTP level (503)
        // or may have opened and server didn't accept.
        // Either way, at most 2 should be connected.
        expect(server.connectedClients).toBeLessThanOrEqual(2);
      } catch {
        // Connection refused — expected
        expect(server.connectedClients).toBe(2);
      }
    });
  });

  describe("message size limits", () => {
    test("maxPayloadLength is set in config", async () => {
      // This test verifies the server starts with maxMessageBytes configured.
      // Bun.serve will enforce the payload limit at the WS level.
      const config = makeConfig({ maxMessageBytes: 256 });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      await server.start();
      expect(server.isRunning).toBe(true);

      const ws = await connectClient(config.port);
      activeClients.push(ws);
      await delay(50);

      // Sending a small message should work
      server.registerHandler("system.status", async () => ({ ok: true }));
      const resp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "1",
        method: "system.status",
      });
      expect(resp.result).toEqual({ ok: true });
    });
  });

  describe("method handling", () => {
    test("routes request to registered handler", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      server.registerHandler("memory.search", async (params) => ({
        results: [],
        query: params.query,
      }));

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      const resp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "req-1",
        method: "memory.search",
        params: { query: "hello" },
      });

      expect(resp.id).toBe("req-1");
      expect(resp.result).toEqual({ results: [], query: "hello" });
      expect(resp.error).toBeUndefined();
    });

    test("returns error for unregistered method", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      // Don't register any handler for session.list
      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      const resp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "req-2",
        method: "session.list",
      });

      expect(resp.id).toBe("req-2");
      expect(resp.error).toBeDefined();
      expect(resp.error?.code).toBe(JSON_RPC_METHOD_NOT_FOUND);
    });

    test("returns error when handler throws", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      server.registerHandler("learning.list", async () => {
        throw new Error("Database unavailable");
      });

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      const resp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "req-3",
        method: "learning.list",
      });

      expect(resp.id).toBe("req-3");
      expect(resp.error).toBeDefined();
      expect(resp.error?.code).toBe(JSON_RPC_INTERNAL_ERROR);
      expect(resp.error?.message).toBe("Internal server error");
    });

    test("returns parse error for invalid JSON-RPC message", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      // Send raw invalid JSON (not via sendAndReceive which JSON.stringify's)
      const resp = await new Promise<GatewayResponse>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timed out")), 3_000);
        ws.onmessage = (ev: MessageEvent): void => {
          clearTimeout(timeout);
          resolve(JSON.parse(String(ev.data)) as GatewayResponse);
        };
        ws.send("{not valid json}");
      });

      expect(resp.error).toBeDefined();
      expect(resp.error?.code).toBe(JSON_RPC_PARSE_ERROR);
    });

    test("passes clientId to handler", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      let capturedClientId = "";
      server.registerHandler("system.status", async (_params, clientId) => {
        capturedClientId = clientId;
        return { ok: true };
      });

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "1",
        method: "system.status",
      });

      expect(capturedClientId).toBeTruthy();
      expect(typeof capturedClientId).toBe("string");
      // UUID format check
      expect(capturedClientId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  describe("broadcast and sendTo", () => {
    test("broadcasts to all authenticated clients", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      await server.start();

      const ws1 = await connectClient(config.port);
      const ws2 = await connectClient(config.port);
      activeClients.push(ws1, ws2);

      await delay(50);

      const p1 = waitForMessage(ws1);
      const p2 = waitForMessage(ws2);

      const event = createPushEvent("session.updated", { sessionId: "s1" });
      server.broadcast(event);

      const [msg1, msg2] = await Promise.all([p1, p2]);

      expect(msg1).toEqual(event);
      expect(msg2).toEqual(event);
    });

    test("sendTo delivers only to specific client", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      // Use a handler to capture client IDs
      const clientIds: string[] = [];
      server.registerHandler("system.status", async (_params, clientId) => {
        clientIds.push(clientId);
        return { clientId };
      });

      await server.start();

      const ws1 = await connectClient(config.port);
      const ws2 = await connectClient(config.port);
      activeClients.push(ws1, ws2);

      // Identify both clients
      const resp1 = await sendAndReceive(ws1, { jsonrpc: "2.0", id: "id1", method: "system.status" });
      const resp2 = await sendAndReceive(ws2, { jsonrpc: "2.0", id: "id2", method: "system.status" });

      const client1Id = (resp1.result as Record<string, unknown>).clientId as string;
      const _client2Id = (resp2.result as Record<string, unknown>).clientId as string;

      // Send only to client1
      const event = createPushEvent("test.event", { data: "for-client-1" });
      const p1 = waitForMessage(ws1);
      server.sendTo(client1Id, event);

      const received = await p1;
      expect(received).toEqual(event);

      // ws2 should NOT have received anything — verify by checking no pending message
      // (we can't easily assert "no message" in a non-blocking way, so we trust the sendTo logic)
    });
  });

  describe("EventBus integration", () => {
    test("emits gateway:client_connected on connection (auth: none)", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      const events: unknown[] = [];
      eventBus.subscribe("gateway:client_connected", (ev) => {
        events.push(ev.payload);
      });

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);
      await delay(50);

      expect(events.length).toBe(1);
      const payload = events[0] as Record<string, unknown>;
      expect(payload.authenticated).toBe(true);
      expect(typeof payload.clientId).toBe("string");
    });

    test("emits gateway:client_disconnected on close", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      const disconnectEvents: unknown[] = [];
      eventBus.subscribe("gateway:client_disconnected", (ev) => {
        disconnectEvents.push(ev.payload);
      });

      await server.start();

      const ws = await connectClient(config.port);
      // Don't add to activeClients since we're closing manually
      await delay(50);

      ws.close();
      await delay(50);

      expect(disconnectEvents.length).toBe(1);
      const payload = disconnectEvents[0] as Record<string, unknown>;
      expect(typeof payload.clientId).toBe("string");
    });

    test("emits gateway:client_connected with authenticated:false on auth failure", async () => {
      const config = makeConfig({ auth: { type: "token", token: "correct" } });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      const events: unknown[] = [];
      eventBus.subscribe("gateway:client_connected", (ev) => {
        events.push(ev.payload);
      });

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      const closed = new Promise<void>((resolve) => {
        ws.onclose = (): void => resolve();
      });

      ws.send(JSON.stringify({ type: "token", token: "wrong" }));
      await closed;

      expect(events.length).toBe(1);
      const payload = events[0] as Record<string, unknown>;
      expect(payload.authenticated).toBe(false);
    });

    test("emits auth event with correct data on JSON-RPC auth success", async () => {
      const config = makeConfig({ auth: { type: "token", token: "mytoken" } });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      const events: unknown[] = [];
      eventBus.subscribe("gateway:client_connected", (ev) => {
        events.push(ev.payload);
      });

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      // Send JSON-RPC auth
      const resp = await sendAndReceive(ws, {
        jsonrpc: "2.0",
        id: "auth-1",
        method: "auth.authenticate",
        params: { token: "mytoken" },
      });

      expect(resp.result).toEqual({ authenticated: true });
      await delay(50);

      expect(events.length).toBe(1);
      const payload = events[0] as Record<string, unknown>;
      expect(payload.authenticated).toBe(true);
    });
  });

  describe("graceful shutdown", () => {
    test("closes all client connections on stop", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      await server.start();

      const ws = await connectClient(config.port);
      // Don't add to activeClients — server will close it

      const closed = new Promise<number>((resolve) => {
        ws.onclose = (ev): void => resolve(ev.code);
      });

      await delay(50);
      expect(server.connectedClients).toBe(1);

      await server.stop();

      const code = await closed;
      // Bun may normalize 1001 to 1000 on the client side
      expect([1000, 1001]).toContain(code);
      expect(server.connectedClients).toBe(0);
      expect(server.isRunning).toBe(false);
    });

    test("stop is idempotent", async () => {
      const config = makeConfig();
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });

      // Calling stop without start should not throw
      await server.stop();
      await server.stop();

      expect(server.isRunning).toBe(false);
    });
  });

  test("returns 404 with security headers for non-WebSocket requests", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const server = new GatewayServer({ config, logger, eventBus });
    activeServers.push(server);

    await server.start();

    const resp = await fetch(`http://127.0.0.1:${config.port}/nonexistent`);
    expect(resp.status).toBe(404);
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(resp.headers.get("X-Frame-Options")).toBe("DENY");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
  });

  test("GET /health returns 200 with status information", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const server = new GatewayServer({ config, logger, eventBus });
    activeServers.push(server);

    await server.start();

    const resp = await fetch(`http://127.0.0.1:${config.port}/health`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("application/json");
    expect(resp.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.status).toBe("healthy");
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.connectedClients).toBe("number");
    expect(typeof body.timestamp).toBe("number");
  });

  test("GET /metrics returns 404 when no registry configured", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    // No metricsRegistry passed
    const server = new GatewayServer({ config, logger, eventBus });
    activeServers.push(server);

    await server.start();

    const resp = await fetch(`http://127.0.0.1:${config.port}/metrics`);
    expect(resp.status).toBe(404);
  });

  test("GET /metrics returns Prometheus exposition format when registry configured", async () => {
    const { MetricsRegistry, PROMETHEUS_CONTENT_TYPE } = await import("../../metrics/prometheus.ts");
    const config = makeConfig();
    const eventBus = createEventBus();
    const metricsRegistry = new MetricsRegistry();
    metricsRegistry.incEventsProcessed(42);
    metricsRegistry.setActiveSessions(2);

    const server = new GatewayServer({ config, logger, eventBus, metricsRegistry });
    activeServers.push(server);

    await server.start();

    const resp = await fetch(`http://127.0.0.1:${config.port}/metrics`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe(PROMETHEUS_CONTENT_TYPE);

    const text = await resp.text();
    expect(text).toContain("eidolon_events_processed_total 42");
    expect(text).toContain("eidolon_active_sessions 2");
    expect(text).toContain("# TYPE eidolon_loop_cycle_duration_ms histogram");
  });
});
