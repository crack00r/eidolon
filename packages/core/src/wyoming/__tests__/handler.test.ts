/**
 * Tests for WyomingHandler -- event processing logic.
 */

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import type { SttResult } from "../../gpu/stt-client.ts";
import type { TtsResult } from "../../gpu/tts-client.ts";
import { createLogger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { WyomingHandler } from "../handler.ts";
import { WyomingParser } from "../protocol.ts";

// ---------------------------------------------------------------------------
// Mock STT/TTS clients
// ---------------------------------------------------------------------------

class MockSTTClient {
  transcribeResult: Result<SttResult, EidolonError> = Ok({
    text: "Hello Eidolon",
    language: "en",
    confidence: 0.95,
    durationSeconds: 1.5,
  });

  lastAudio: Uint8Array | null = null;

  async transcribe(audio: Uint8Array, _mimeType?: string): Promise<Result<SttResult, EidolonError>> {
    this.lastAudio = audio;
    return this.transcribeResult;
  }
}

class MockTTSClient {
  synthesizeResult: Result<TtsResult, EidolonError> = Ok({
    audio: new Uint8Array([0x01, 0x02, 0x03]),
    format: "wav",
    durationMs: 500,
  });

  lastText: string | null = null;

  async synthesize(request: {
    text: string;
    voice?: string;
    format?: string;
  }): Promise<Result<TtsResult, EidolonError>> {
    this.lastText = request.text;
    return this.synthesizeResult;
  }
}

// ---------------------------------------------------------------------------
// Test helpers
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

function createTestLogger() {
  return createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 10, maxFiles: 1 });
}

function createHandlerWithMocks(): {
  handler: WyomingHandler;
  stt: MockSTTClient;
  tts: MockTTSClient;
  eventBus: EventBus;
} {
  const db = createTestDb();
  const logger = createTestLogger();
  const eventBus = new EventBus(db, logger);
  const stt = new MockSTTClient();
  const tts = new MockTTSClient();

  // Cast mocks to the interface types the handler expects
  const handler = new WyomingHandler({
    stt: stt as unknown as import("../../gpu/stt-client.ts").STTClient,
    tts: tts as unknown as import("../../gpu/tts-client.ts").TTSClient,
    eventBus,
    logger,
  });

  return { handler, stt, tts, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WyomingHandler", () => {
  describe("describe event", () => {
    it("responds with info event listing capabilities", async () => {
      const { handler } = createHandlerWithMocks();

      const result = await handler.handleEvent({ type: "describe", data: {}, payload: null }, "test-satellite");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);

      // Parse the response
      const parser = new WyomingParser();
      const firstResponse = result.value[0];
      expect(firstResponse).toBeDefined();
      if (!firstResponse) return;
      parser.feed(firstResponse);
      const events = parser.take();
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("info");
    });
  });

  describe("ping event", () => {
    it("responds with pong", async () => {
      const { handler } = createHandlerWithMocks();

      const result = await handler.handleEvent({ type: "ping", data: {}, payload: null }, "test-satellite");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);

      const parser = new WyomingParser();
      const firstResponse = result.value[0];
      expect(firstResponse).toBeDefined();
      if (!firstResponse) return;
      parser.feed(firstResponse);
      const events = parser.take();
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("pong");
    });
  });

  describe("audio session (STT)", () => {
    it("processes audio-start, audio-chunk, audio-stop sequence", async () => {
      const { handler, stt, eventBus } = createHandlerWithMocks();
      const publishedEvents: string[] = [];
      eventBus.subscribe("user:message", (ev) => {
        publishedEvents.push(ev.type);
      });

      // audio-start
      const startResult = await handler.handleEvent(
        {
          type: "audio-start",
          data: { rate: 16_000, width: 2, channels: 1 },
          payload: null,
        },
        "test-satellite",
      );
      expect(startResult.ok).toBe(true);

      // audio-chunk
      const audioData = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
      const chunkResult = await handler.handleEvent(
        {
          type: "audio-chunk",
          data: { rate: 16_000, width: 2, channels: 1 },
          payload: audioData,
        },
        "test-satellite",
      );
      expect(chunkResult.ok).toBe(true);

      // audio-stop
      const stopResult = await handler.handleEvent({ type: "audio-stop", data: {}, payload: null }, "test-satellite");
      expect(stopResult.ok).toBe(true);
      if (!stopResult.ok) return;

      // Verify STT was called
      expect(stt.lastAudio).toEqual(audioData);

      // Verify transcript event was sent back
      const parser = new WyomingParser();
      const firstResponse = stopResult.value[0];
      expect(firstResponse).toBeDefined();
      if (!firstResponse) return;
      parser.feed(firstResponse);
      const events = parser.take();
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("transcript");
      const data = events[0]?.data as Record<string, unknown>;
      expect(data.text).toBe("Hello Eidolon");

      // Verify EventBus received the message
      expect(publishedEvents).toContain("user:message");
    });

    it("rejects audio-chunk without audio-start", async () => {
      const { handler } = createHandlerWithMocks();

      const result = await handler.handleEvent(
        {
          type: "audio-chunk",
          data: { rate: 16_000, width: 2, channels: 1 },
          payload: new Uint8Array([0x01]),
        },
        "test-satellite",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("WYOMING_PROTOCOL_ERROR");
    });

    it("rejects audio-stop without audio-start", async () => {
      const { handler } = createHandlerWithMocks();

      const result = await handler.handleEvent({ type: "audio-stop", data: {}, payload: null }, "test-satellite");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("WYOMING_PROTOCOL_ERROR");
    });

    it("returns empty for zero-byte audio sessions", async () => {
      const { handler } = createHandlerWithMocks();

      await handler.handleEvent(
        { type: "audio-start", data: { rate: 16_000, width: 2, channels: 1 }, payload: null },
        "test-satellite",
      );

      const result = await handler.handleEvent({ type: "audio-stop", data: {}, payload: null }, "test-satellite");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });
  });

  describe("synthesize event (TTS)", () => {
    it("synthesizes text and returns audio events", async () => {
      const { handler, tts } = createHandlerWithMocks();

      const result = await handler.handleEvent(
        {
          type: "synthesize",
          data: { text: "Hello from Eidolon" },
          payload: null,
        },
        "test-satellite",
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(tts.lastText).toBe("Hello from Eidolon");

      // Should return audio-start, audio-chunk, audio-stop
      expect(result.value).toHaveLength(3);

      const parser = new WyomingParser();
      for (const response of result.value) {
        parser.feed(response);
      }
      const events = parser.take();
      expect(events).toHaveLength(3);
      expect(events[0]?.type).toBe("audio-start");
      expect(events[1]?.type).toBe("audio-chunk");
      expect(events[2]?.type).toBe("audio-stop");

      // audio-chunk should have the TTS audio as payload
      expect(events[1]?.payload).toEqual(new Uint8Array([0x01, 0x02, 0x03]));
    });

    it("rejects synthesize with missing text", async () => {
      const { handler } = createHandlerWithMocks();

      const result = await handler.handleEvent(
        {
          type: "synthesize",
          data: {},
          payload: null,
        },
        "test-satellite",
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("WYOMING_PROTOCOL_ERROR");
    });
  });

  describe("unhandled events", () => {
    it("returns empty array for unknown event types", async () => {
      const { handler } = createHandlerWithMocks();

      const result = await handler.handleEvent({ type: "detection", data: {}, payload: null }, "test-satellite");

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(0);
    });
  });

  describe("reset", () => {
    it("clears audio session on reset", async () => {
      const { handler } = createHandlerWithMocks();

      // Start audio session
      await handler.handleEvent(
        { type: "audio-start", data: { rate: 16_000, width: 2, channels: 1 }, payload: null },
        "test-satellite",
      );

      handler.reset();

      // audio-stop should fail since session was cleared
      const result = await handler.handleEvent({ type: "audio-stop", data: {}, payload: null }, "test-satellite");

      expect(result.ok).toBe(false);
    });
  });
});
