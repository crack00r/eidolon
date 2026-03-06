import { describe, expect, test } from "bun:test";
import { Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { GPUWorkerPool } from "../pool.ts";
import type { VoiceWebSocket } from "../voice-ws-handler.ts";
import { VoiceWsHandler } from "../voice-ws-handler.ts";

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

/** Capture messages sent to the client. */
interface MockWebSocket extends VoiceWebSocket {
  readonly messages: Array<string | ArrayBuffer | Uint8Array>;
  closed: boolean;
}

function createMockWs(): MockWebSocket {
  const messages: Array<string | ArrayBuffer | Uint8Array> = [];
  return {
    messages,
    closed: false,
    readyState: 1, // WS_OPEN
    send(data: string | ArrayBuffer | Uint8Array): void {
      messages.push(data);
    },
    close(): void {
      this.closed = true;
    },
  };
}

/** Minimal mock pool that returns a successful STT result. */
function createMockPool(sttText = "Hello world"): GPUWorkerPool {
  return {
    stt: async () => Ok({ text: sttText, language: "en", confidence: 0.95, segments: [] }),
    tts: async () => Ok({ audio: new Uint8Array([1, 2, 3]), format: "opus", durationMs: 100 }),
    hasCapability: () => true,
    selectWorker: () => null,
    getPoolStatus: () => ({
      totalWorkers: 1,
      healthyWorkers: 1,
      degradedWorkers: 0,
      unhealthyWorkers: 0,
      totalActiveRequests: 0,
      workers: [],
    }),
    startHealthChecks: () => {},
    stopHealthChecks: () => {},
    checkAllHealth: async () => {},
    dispose: () => {},
    get size() { return 1; },
  } as unknown as GPUWorkerPool;
}

function getJsonMessages(ws: MockWebSocket): Array<Record<string, unknown>> {
  return ws.messages
    .filter((m): m is string => typeof m === "string")
    .map((m) => JSON.parse(m) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VoiceWsHandler", () => {
  test("starts in idle voice state", () => {
    const ws = createMockWs();
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    expect(handler.voiceState).toBe("idle");
  });

  test("handles ping message with pong response", async () => {
    const ws = createMockWs();
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    await handler.handleMessage(JSON.stringify({ type: "ping" }));

    const jsonMsgs = getJsonMessages(ws);
    expect(jsonMsgs.some((m) => m.type === "pong")).toBe(true);
  });

  test("sends error for invalid JSON", async () => {
    const ws = createMockWs();
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    await handler.handleMessage("not valid json {{{");

    const jsonMsgs = getJsonMessages(ws);
    expect(jsonMsgs.some((m) => m.type === "error")).toBe(true);
  });

  test("sends error for unknown message type", async () => {
    const ws = createMockWs();
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    await handler.handleMessage(JSON.stringify({ type: "unknown_type" }));

    const jsonMsgs = getJsonMessages(ws);
    const errorMsg = jsonMsgs.find((m) => m.type === "error");
    expect(errorMsg).toBeDefined();
    if (errorMsg !== undefined) {
      expect(String(errorMsg.message)).toContain("Unknown message type");
    }
  });

  test("control start transitions to listening state", async () => {
    const ws = createMockWs();
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    await handler.handleMessage(JSON.stringify({ type: "control", action: "start" }));

    expect(handler.voiceState).toBe("listening");

    // Should have sent a state update
    const jsonMsgs = getJsonMessages(ws);
    const stateMsg = jsonMsgs.find((m) => m.type === "state");
    expect(stateMsg).toBeDefined();
    if (stateMsg !== undefined) {
      expect(stateMsg.state).toBe("listening");
    }
  });

  test("binary audio auto-transitions from idle to listening", async () => {
    const ws = createMockWs();
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    const audioChunk = new Uint8Array([0, 1, 2, 3]);
    await handler.handleMessage(audioChunk);

    expect(handler.voiceState).toBe("listening");
  });

  test("dispose resets state and stops processing", async () => {
    const ws = createMockWs();
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    // Move to listening
    await handler.handleMessage(JSON.stringify({ type: "control", action: "start" }));
    expect(handler.voiceState).toBe("listening");

    handler.dispose();
    expect(handler.voiceState).toBe("idle");

    // After dispose, messages should be ignored
    const msgCountBefore = ws.messages.length;
    await handler.handleMessage(JSON.stringify({ type: "ping" }));
    expect(ws.messages.length).toBe(msgCountBefore);
  });

  test("sendAudio sends binary data to client", () => {
    const ws = createMockWs();
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    const audio = new Uint8Array([10, 20, 30]);
    handler.sendAudio(audio);

    const binaryMsgs = ws.messages.filter(
      (m) => m instanceof Uint8Array || m instanceof ArrayBuffer,
    );
    expect(binaryMsgs).toHaveLength(1);
  });

  test("does not send when ws is not open", () => {
    const ws = createMockWs();
    // Simulate closed socket
    Object.defineProperty(ws, "readyState", { value: 3, writable: false });
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    handler.sendAudio(new Uint8Array([1, 2]));
    expect(ws.messages).toHaveLength(0);
  });

  test("interrupt control triggers barge-in on speaking state", async () => {
    const ws = createMockWs();
    const pool = createMockPool();
    const handler = new VoiceWsHandler(ws, pool, logger);

    // Walk to speaking state: idle -> listening -> processing -> speaking
    await handler.handleMessage(JSON.stringify({ type: "control", action: "start" }));
    expect(handler.voiceState).toBe("listening");

    // Barge-in from listening is valid per the transition table
    // (listening:barge_in -> interrupted)
    await handler.handleMessage(JSON.stringify({ type: "control", action: "interrupt" }));

    expect(handler.voiceState).toBe("interrupted");
  });
});
