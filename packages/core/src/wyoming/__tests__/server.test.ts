/**
 * Tests for WyomingServer -- TCP server and connection management.
 */

import { createConnection, type Socket } from "node:net";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, beforeEach } from "bun:test";
import { Ok } from "@eidolon/protocol";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { WyomingServer } from "../server.ts";
import { WyomingHandler } from "../handler.ts";
import { WyomingParser, serializeEvent } from "../protocol.ts";
import type { SttResult } from "../../gpu/stt-client.ts";
import type { TtsResult } from "../../gpu/tts-client.ts";
import type { WyomingConfig } from "../config.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockSTTClient {
  async transcribe(_audio: Uint8Array, _mimeType?: string): Promise<Result<SttResult, EidolonError>> {
    return Ok({ text: "test transcript", language: "en", confidence: 0.9, durationSeconds: 1.0 });
  }
}

class MockTTSClient {
  async synthesize(_request: { text: string }): Promise<Result<TtsResult, EidolonError>> {
    return Ok({ audio: new Uint8Array([0xaa, 0xbb]), format: "wav", durationMs: 100 });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal',
    payload TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'system',
    timestamp INTEGER NOT NULL,
    processed_at INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0
  )`);
  return db;
}

function createTestConfig(overrides?: Partial<WyomingConfig>): WyomingConfig {
  return {
    enabled: true,
    port: 0, // OS-assigned port
    allowedSatellites: [],
    audioFormat: "wav",
    sampleRate: 16_000,
    audioChannels: 1,
    bitsPerSample: 16,
    ...overrides,
  };
}

function createTestServer(
  config?: Partial<WyomingConfig>,
): { server: WyomingServer; eventBus: EventBus } {
  const db = createTestDb();
  const logger = createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 10, maxFiles: 1 });
  const eventBus = new EventBus(db, logger);
  const stt = new MockSTTClient();
  const tts = new MockTTSClient();

  const server = new WyomingServer({
    config: createTestConfig(config),
    handlerFactory: (_satelliteId: string) =>
      new WyomingHandler({
        stt: stt as unknown as import("../../gpu/stt-client.ts").STTClient,
        tts: tts as unknown as import("../../gpu/tts-client.ts").TTSClient,
        eventBus,
        logger,
      }),
    logger,
  });

  return { server, eventBus };
}

/** Connect to the server and wait for the connection to be established. */
function connectToServer(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ port, host: "127.0.0.1" }, () => {
      resolve(socket);
    });
    socket.on("error", reject);
  });
}

/** Send data and wait for a response. */
function sendAndReceive(socket: Socket, data: Uint8Array, timeoutMs = 2000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.removeAllListeners("data");
      if (chunks.length > 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error("Timeout waiting for response"));
      }
    }, timeoutMs);

    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      // Give a small delay for additional data
      clearTimeout(timer);
      setTimeout(() => {
        socket.removeAllListeners("data");
        resolve(Buffer.concat(chunks));
      }, 100);
    });

    socket.write(data);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WyomingServer", () => {
  let server: WyomingServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it("starts and accepts connections", async () => {
    const result = createTestServer();
    server = result.server;

    const startResult = await server.start();
    expect(startResult.ok).toBe(true);
    expect(server.port).toBeGreaterThan(0);

    const socket = await connectToServer(server.port!);
    // Allow connection handler to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(server.connectionCount).toBe(1);
    socket.destroy();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.connectionCount).toBe(0);
  });

  it("responds to ping with pong", async () => {
    const result = createTestServer();
    server = result.server;
    await server.start();

    const socket = await connectToServer(server.port!);

    const pingEvent = serializeEvent({ type: "ping", data: {}, payload: null });
    const response = await sendAndReceive(socket, pingEvent);

    const parser = new WyomingParser();
    parser.feed(new Uint8Array(response));
    const events = parser.take();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("pong");

    socket.destroy();
  });

  it("responds to describe with info", async () => {
    const result = createTestServer();
    server = result.server;
    await server.start();

    const socket = await connectToServer(server.port!);

    const describeEvent = serializeEvent({ type: "describe", data: {}, payload: null });
    const response = await sendAndReceive(socket, describeEvent);

    const parser = new WyomingParser();
    parser.feed(new Uint8Array(response));
    const events = parser.take();

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("info");

    socket.destroy();
  });

  it("does not start when disabled", async () => {
    const result = createTestServer({ enabled: false });
    server = result.server;

    const startResult = await server.start();
    expect(startResult.ok).toBe(true);
    expect(server.port).toBeNull();
  });

  it("stops cleanly", async () => {
    const result = createTestServer();
    server = result.server;
    await server.start();
    const port = server.port;
    expect(port).toBeGreaterThan(0);

    await server.stop();
    expect(server.connectionCount).toBe(0);
  });

  it("rejects double start", async () => {
    const result = createTestServer();
    server = result.server;
    await server.start();

    const secondStart = await server.start();
    expect(secondStart.ok).toBe(false);
  });
});
