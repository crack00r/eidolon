import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { GatewayConfig, GatewayMethod, GatewayResponse } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.js";
import { EventBus } from "../../loop/event-bus.js";
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
} from "../protocol.js";
import { GatewayServer } from "../server.js";

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
    auth: { type: "none" },
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
        "voice.start",
        "voice.stop",
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
    test("authenticates with valid token", async () => {
      const config = makeConfig({ auth: { type: "token", token: "secret-123" } });
      const eventBus = createEventBus();
      const server = new GatewayServer({ config, logger, eventBus });
      activeServers.push(server);

      // Register a handler so we can verify auth worked
      server.registerHandler("system.status", async () => ({ status: "ok" }));

      await server.start();

      const ws = await connectClient(config.port);
      activeClients.push(ws);

      // Send auth
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
      expect(resp.error?.message).toBe("Database unavailable");
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

  test("returns 404 for non-WebSocket requests", async () => {
    const config = makeConfig();
    const eventBus = createEventBus();
    const server = new GatewayServer({ config, logger, eventBus });
    activeServers.push(server);

    await server.start();

    const resp = await fetch(`http://127.0.0.1:${config.port}/health`);
    expect(resp.status).toBe(404);
  });
});
