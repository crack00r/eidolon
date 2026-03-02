import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ErrorCode } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.js";
import { RealtimeVoiceClient } from "../realtime-client.js";

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

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type MockWSEventHandler = (event: Record<string, unknown>) => void;

interface MockWebSocketInstance {
  url: string;
  binaryType: string;
  readyState: number;
  onopen: MockWSEventHandler | null;
  onclose: MockWSEventHandler | null;
  onmessage: MockWSEventHandler | null;
  onerror: MockWSEventHandler | null;
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
  simulateOpen: () => void;
  simulateMessage: (data: string | ArrayBuffer) => void;
  simulateClose: (code?: number, reason?: string) => void;
  simulateError: () => void;
}

/** All mock WS instances created during the test. */
let mockInstances: MockWebSocketInstance[] = [];

function createMockWebSocketClass(): typeof WebSocket {
  function MockWebSocket(this: MockWebSocketInstance, url: string): void {
    this.url = url;
    this.binaryType = "blob";
    this.readyState = 0; // CONNECTING
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
    this.onerror = null;
    this.send = mock(() => {});
    this.close = mock((_code?: number, _reason?: string) => {
      this.readyState = 3; // CLOSED
    });

    this.simulateOpen = (): void => {
      this.readyState = 1; // OPEN
      if (this.onopen) this.onopen({});
    };

    this.simulateMessage = (data: string | ArrayBuffer): void => {
      if (this.onmessage) this.onmessage({ data });
    };

    this.simulateClose = (code = 1000, reason = ""): void => {
      this.readyState = 3; // CLOSED
      if (this.onclose) this.onclose({ code, reason, wasClean: code === 1000 });
    };

    this.simulateError = (): void => {
      if (this.onerror) this.onerror({});
    };

    mockInstances.push(this);
  }

  // Static constants
  MockWebSocket.CONNECTING = 0;
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;

  return MockWebSocket as unknown as typeof WebSocket;
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let originalWebSocket: typeof WebSocket;

beforeEach(() => {
  mockInstances = [];
  originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = createMockWebSocketClass();
});

afterEach(() => {
  globalThis.WebSocket = originalWebSocket;
});

function getLatestMockWs(): MockWebSocketInstance {
  const ws = mockInstances[mockInstances.length - 1];
  if (!ws) throw new Error("No mock WebSocket instance created");
  return ws;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("RealtimeVoiceClient", () => {
  describe("connect", () => {
    test("connects successfully and returns Ok", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "test-key");

      // Simulate successful connection
      const ws = getLatestMockWs();
      ws.simulateOpen();

      const result = await connectPromise;

      expect(result.ok).toBe(true);
      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    test("builds correct WebSocket URL with token", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "my-secret");
      const ws = getLatestMockWs();
      ws.simulateOpen();

      await connectPromise;

      expect(ws.url).toBe("ws://localhost:8420/voice/realtime?token=my-secret");

      await client.disconnect();
    });

    test("converts https to wss", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("https://gpu.example.com", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();

      await connectPromise;

      expect(ws.url).toBe("wss://gpu.example.com/voice/realtime?token=key");

      await client.disconnect();
    });

    test("handles ws:// URLs directly", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("ws://gpu.local:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();

      await connectPromise;

      expect(ws.url).toBe("ws://gpu.local:8420/voice/realtime?token=key");

      await client.disconnect();
    });

    test("returns Err when connection fails", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "bad-key");
      const ws = getLatestMockWs();
      ws.simulateClose(4001, "Invalid or missing token");

      const result = await connectPromise;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(ErrorCode.GPU_UNAVAILABLE);
      }
    });

    test("returns Err when already connected", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      const secondResult = await client.connect("http://localhost:8420", "key");

      expect(secondResult.ok).toBe(false);
      if (!secondResult.ok) {
        expect(secondResult.error.code).toBe(ErrorCode.GPU_UNAVAILABLE);
        expect(secondResult.error.message).toContain("Already connected");
      }

      await client.disconnect();
    });

    test("URL-encodes special characters in token", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key with spaces&special=chars");
      const ws = getLatestMockWs();
      ws.simulateOpen();

      await connectPromise;

      expect(ws.url).toContain("token=key%20with%20spaces%26special%3Dchars");

      await client.disconnect();
    });
  });

  describe("disconnect", () => {
    test("closes the WebSocket cleanly", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      expect(client.isConnected()).toBe(true);

      await client.disconnect();

      expect(ws.close).toHaveBeenCalledWith(1000, "Client disconnect");
      expect(client.isConnected()).toBe(false);
    });

    test("is safe to call when not connected", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      // Should not throw
      await client.disconnect();

      expect(client.isConnected()).toBe(false);
    });
  });

  describe("sendAudio", () => {
    test("sends binary data over WebSocket", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      const audioData = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
      client.sendAudio(audioData);

      expect(ws.send).toHaveBeenCalledWith(audioData);

      await client.disconnect();
    });

    test("notifies error callback when not connected", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const errors: Error[] = [];
      client.onError((err) => errors.push(err));

      client.sendAudio(new Uint8Array([1, 2, 3]));

      expect(errors.length).toBe(1);
      expect(errors[0]?.message).toContain("not connected");
    });
  });

  describe("requestTts", () => {
    test("sends TTS request as JSON text frame", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      client.requestTts("Hello world", "Ryan");

      const expectedPayload = JSON.stringify({ type: "tts", text: "Hello world", voice: "Ryan" });
      expect(ws.send).toHaveBeenCalledWith(expectedPayload);

      await client.disconnect();
    });

    test("uses default voice when not specified", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      client.requestTts("Test text");

      const expectedPayload = JSON.stringify({ type: "tts", text: "Test text", voice: "default" });
      expect(ws.send).toHaveBeenCalledWith(expectedPayload);

      await client.disconnect();
    });

    test("notifies error callback when not connected", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const errors: Error[] = [];
      client.onError((err) => errors.push(err));

      client.requestTts("Hello");

      expect(errors.length).toBe(1);
      expect(errors[0]?.message).toContain("not connected");
    });
  });

  describe("onTranscription", () => {
    test("invokes callback when transcript message received", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const transcriptions: Array<{ text: string; isFinal: boolean }> = [];
      client.onTranscription((text, isFinal) => transcriptions.push({ text, isFinal }));

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      ws.simulateMessage(JSON.stringify({ type: "transcript", text: "Hello world", final: true }));

      expect(transcriptions.length).toBe(1);
      expect(transcriptions[0]?.text).toBe("Hello world");
      expect(transcriptions[0]?.isFinal).toBe(true);

      await client.disconnect();
    });

    test("handles partial (non-final) transcriptions", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const transcriptions: Array<{ text: string; isFinal: boolean }> = [];
      client.onTranscription((text, isFinal) => transcriptions.push({ text, isFinal }));

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      ws.simulateMessage(JSON.stringify({ type: "transcript", text: "Hel", final: false }));
      ws.simulateMessage(JSON.stringify({ type: "transcript", text: "Hello world", final: true }));

      expect(transcriptions.length).toBe(2);
      expect(transcriptions[0]?.isFinal).toBe(false);
      expect(transcriptions[1]?.isFinal).toBe(true);

      await client.disconnect();
    });
  });

  describe("onAudio", () => {
    test("invokes callback when binary audio received", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const audioChunks: Uint8Array[] = [];
      client.onAudio((chunk) => audioChunks.push(chunk));

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      const buffer = new Uint8Array([0xaa, 0xbb, 0xcc]).buffer;
      ws.simulateMessage(buffer);

      expect(audioChunks.length).toBe(1);
      expect(audioChunks[0]).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));

      await client.disconnect();
    });
  });

  describe("onError", () => {
    test("invokes callback on server error messages", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const errors: Error[] = [];
      client.onError((err) => errors.push(err));

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      ws.simulateMessage(JSON.stringify({ type: "error", message: "TTS model not loaded" }));

      expect(errors.length).toBe(1);
      expect(errors[0]?.message).toContain("TTS model not loaded");

      await client.disconnect();
    });

    test("handles callback that throws", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const errors: Error[] = [];

      // First callback throws
      client.onError(() => {
        throw new Error("callback bug");
      });
      // Second callback should still be called
      client.onError((err) => errors.push(err));

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      ws.simulateMessage(JSON.stringify({ type: "error", message: "test" }));

      expect(errors.length).toBe(1);

      await client.disconnect();
    });
  });

  describe("isConnected", () => {
    test("returns false when not connected", () => {
      const client = new RealtimeVoiceClient(logger);
      expect(client.isConnected()).toBe(false);
    });

    test("returns true when connected", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      expect(client.isConnected()).toBe(true);

      await client.disconnect();
    });

    test("returns false after disconnect", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      await client.disconnect();

      expect(client.isConnected()).toBe(false);
    });
  });

  describe("ping/pong keep-alive", () => {
    test("sends ping on interval", async () => {
      const client = new RealtimeVoiceClient(logger, {
        pingIntervalMs: 50,
        maxReconnectAttempts: 0,
      });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      // Wait for at least one ping
      await new Promise((resolve) => setTimeout(resolve, 80));

      const pingSent = (ws.send as ReturnType<typeof mock>).mock.calls.some(
        (call) => typeof call[0] === "string" && (call[0] as string).includes('"type":"ping"'),
      );
      expect(pingSent).toBe(true);

      await client.disconnect();
    });
  });

  describe("message parsing", () => {
    test("handles malformed JSON gracefully", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const errors: Error[] = [];
      client.onError((err) => errors.push(err));

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      // Should not throw
      ws.simulateMessage("not valid json {{{");

      // Malformed JSON should not trigger error callback — it's logged as a warning
      expect(errors.length).toBe(0);

      await client.disconnect();
    });

    test("handles unknown message types gracefully", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      // Should not throw
      ws.simulateMessage(JSON.stringify({ type: "unknown_type", data: "test" }));

      await client.disconnect();
    });

    test("handles state messages without crashing", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      ws.simulateMessage(JSON.stringify({ type: "state", state: "listening" }));
      ws.simulateMessage(JSON.stringify({ type: "state", state: "processing" }));
      ws.simulateMessage(JSON.stringify({ type: "state", state: "idle" }));

      // No error — just logged
      await client.disconnect();
    });
  });

  describe("multiple callbacks", () => {
    test("supports multiple transcription callbacks", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const results1: string[] = [];
      const results2: string[] = [];

      client.onTranscription((text) => results1.push(text));
      client.onTranscription((text) => results2.push(text));

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      ws.simulateMessage(JSON.stringify({ type: "transcript", text: "hello", final: true }));

      expect(results1).toEqual(["hello"]);
      expect(results2).toEqual(["hello"]);

      await client.disconnect();
    });

    test("supports multiple audio callbacks", async () => {
      const client = new RealtimeVoiceClient(logger, { maxReconnectAttempts: 0 });
      const chunks1: Uint8Array[] = [];
      const chunks2: Uint8Array[] = [];

      client.onAudio((chunk) => chunks1.push(chunk));
      client.onAudio((chunk) => chunks2.push(chunk));

      const connectPromise = client.connect("http://localhost:8420", "key");
      const ws = getLatestMockWs();
      ws.simulateOpen();
      await connectPromise;

      ws.simulateMessage(new Uint8Array([1, 2, 3]).buffer);

      expect(chunks1.length).toBe(1);
      expect(chunks2.length).toBe(1);

      await client.disconnect();
    });
  });
});
