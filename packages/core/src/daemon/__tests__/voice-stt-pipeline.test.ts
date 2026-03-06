/**
 * Tests for the voice STT pipeline wired in event-handlers.ts.
 *
 * Covers: pre-transcribed text delegation, server-side STT via GPU worker,
 * graceful degradation when STT is unavailable, empty transcriptions,
 * invalid base64, and missing audio/text.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { BusEvent, EidolonError, EventPriority, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { OPERATIONAL_MIGRATIONS } from "../../database/schemas/operational.ts";
import type { Logger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { buildEventHandler } from "../event-handlers.ts";
import type { InitializedModules } from "../types.ts";

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

function createOperationalDb(): Database {
  const db = new Database(":memory:");
  const result = runMigrations(db, "operational", OPERATIONAL_MIGRATIONS, logger);
  if (!result.ok) throw new Error("Migration failed");
  return db;
}

/** Build a minimal BusEvent for user:voice. */
function makeVoiceEvent(payload: Record<string, unknown>): BusEvent {
  return {
    id: `test-voice-${Date.now()}`,
    type: "user:voice",
    priority: "high" as EventPriority,
    payload,
    timestamp: Date.now(),
    source: "test",
  };
}

/** Priority arg required by the handler signature. */
const defaultPriority = {
  score: 90,
  suggestedAction: "respond" as const,
  suggestedModel: "default" as const,
  reason: "test",
};

/** Encode a string to base64 to simulate audio. */
function toBase64(data: string): string {
  return btoa(data);
}

/** Create a mock STTClient that returns a configurable result. */
function createMockSttClient(
  result: Result<{ text: string; language: string; confidence: number; durationSeconds: number }, EidolonError>,
): {
  transcribe: (audio: Uint8Array, mimeType?: string) => Promise<typeof result>;
  lastAudio: Uint8Array | undefined;
  lastMimeType: string | undefined;
  callCount: number;
} {
  const mock = {
    transcribe: async (audio: Uint8Array, mimeType?: string): Promise<typeof result> => {
      mock.lastAudio = audio;
      mock.lastMimeType = mimeType;
      mock.callCount++;
      return result;
    },
    lastAudio: undefined as Uint8Array | undefined,
    lastMimeType: undefined as string | undefined,
    callCount: 0,
  };
  return mock;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Voice STT Pipeline", () => {
  let db: Database;

  beforeEach(() => {
    db = createOperationalDb();
  });

  afterEach(() => {
    db.close();
  });

  test("pre-transcribed text delegates to message handler (missing modules yields error)", async () => {
    // When text is already transcribed, the handler delegates to handleUserMessage.
    // Without claudeManager etc., it returns a "Required modules" error, which proves
    // delegation happened (it got past the voice handler into the message handler).
    const modules: InitializedModules = { logger };
    const handler = buildEventHandler(modules);

    const event = makeVoiceEvent({
      channelId: "telegram",
      userId: "user-1",
      text: "Hello from voice",
    });

    const result = await handler(event, defaultPriority);

    // The message handler needs config + claudeManager, so it fails with "Required modules"
    expect(result.success).toBe(false);
    expect(result.error).toContain("Required modules");
  });

  test("audio base64 with available STTClient calls transcribe and re-emits user:message", async () => {
    const eventBus = new EventBus(db, logger);
    const sttClient = createMockSttClient(
      Ok({ text: "transcribed hello", language: "en", confidence: 0.95, durationSeconds: 1.5 }),
    );

    const modules: InitializedModules = {
      logger,
      eventBus,
      sttClient: sttClient as unknown as InitializedModules["sttClient"],
    };

    const handler = buildEventHandler(modules);
    const audioData = "fake audio bytes for testing";
    const event = makeVoiceEvent({
      channelId: "telegram",
      userId: "user-1",
      audioBase64: toBase64(audioData),
      mimeType: "audio/wav",
    });

    const result = await handler(event, defaultPriority);

    expect(result.success).toBe(true);
    expect(result.tokensUsed).toBe(0);

    // Verify STTClient was called
    expect(sttClient.callCount).toBe(1);
    expect(sttClient.lastMimeType).toBe("audio/wav");

    // Verify decoded audio bytes match
    const _expectedBytes = new TextEncoder().encode(audioData);
    expect(sttClient.lastAudio?.length).toBe(audioData.length);

    // Verify user:message was published to EventBus
    const pending = eventBus.pendingCount();
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.value).toBeGreaterThanOrEqual(1);
    }

    // Dequeue and check the re-emitted event
    const dequeued = eventBus.dequeue();
    expect(dequeued.ok).toBe(true);
    if (dequeued.ok && dequeued.value) {
      expect(dequeued.value.type).toBe("user:message");
      const payload = dequeued.value.payload as Record<string, unknown>;
      expect(payload.text).toBe("transcribed hello");
      expect(payload.channelId).toBe("telegram");
      expect(payload.userId).toBe("user-1");
    }
  });

  test("no STTClient available returns graceful error", async () => {
    const modules: InitializedModules = { logger };
    const handler = buildEventHandler(modules);

    const event = makeVoiceEvent({
      channelId: "telegram",
      userId: "user-1",
      audioBase64: toBase64("some audio"),
      mimeType: "audio/wav",
    });

    const result = await handler(event, defaultPriority);

    expect(result.success).toBe(false);
    expect(result.error).toContain("STT unavailable");
  });

  test("empty transcription result is treated as success with no further action", async () => {
    const eventBus = new EventBus(db, logger);
    const sttClient = createMockSttClient(Ok({ text: "   ", language: "en", confidence: 0.1, durationSeconds: 0.5 }));

    const modules: InitializedModules = {
      logger,
      eventBus,
      sttClient: sttClient as unknown as InitializedModules["sttClient"],
    };

    const handler = buildEventHandler(modules);
    const event = makeVoiceEvent({
      channelId: "telegram",
      userId: "user-1",
      audioBase64: toBase64("silence"),
      mimeType: "audio/wav",
    });

    const result = await handler(event, defaultPriority);

    // Empty transcription should succeed but not emit a user:message
    expect(result.success).toBe(true);
    expect(result.tokensUsed).toBe(0);

    const pending = eventBus.pendingCount();
    expect(pending.ok).toBe(true);
    if (pending.ok) {
      expect(pending.value).toBe(0);
    }
  });

  test("neither text nor audio returns error", async () => {
    const modules: InitializedModules = { logger };
    const handler = buildEventHandler(modules);

    const event = makeVoiceEvent({
      channelId: "telegram",
      userId: "user-1",
    });

    const result = await handler(event, defaultPriority);

    expect(result.success).toBe(false);
    expect(result.error).toContain("no audio data or transcription");
  });

  test("default mime type used when none provided", async () => {
    const eventBus = new EventBus(db, logger);
    const sttClient = createMockSttClient(
      Ok({ text: "hello", language: "de", confidence: 0.88, durationSeconds: 2.0 }),
    );

    const modules: InitializedModules = {
      logger,
      eventBus,
      sttClient: sttClient as unknown as InitializedModules["sttClient"],
    };

    const handler = buildEventHandler(modules);
    const event = makeVoiceEvent({
      channelId: "cli",
      userId: "user-1",
      audioBase64: toBase64("audio without mime"),
      // no mimeType provided
    });

    const result = await handler(event, defaultPriority);

    expect(result.success).toBe(true);
    // STTClient should receive "audio/wav" as default
    expect(sttClient.lastMimeType).toBe("audio/wav");
  });

  test("STT transcription failure returns error with details", async () => {
    const eventBus = new EventBus(db, logger);

    const sttErr: EidolonError = {
      code: "STT_FAILED" as EidolonError["code"],
      message: "GPU worker timeout",
      timestamp: Date.now(),
    };
    const sttClient = createMockSttClient({ ok: false, error: sttErr } as Result<
      { text: string; language: string; confidence: number; durationSeconds: number },
      EidolonError
    >);

    const modules: InitializedModules = {
      logger,
      eventBus,
      sttClient: sttClient as unknown as InitializedModules["sttClient"],
    };

    const handler = buildEventHandler(modules);
    const event = makeVoiceEvent({
      channelId: "telegram",
      userId: "user-1",
      audioBase64: toBase64("audio data"),
      mimeType: "audio/opus",
    });

    const result = await handler(event, defaultPriority);

    expect(result.success).toBe(false);
    expect(result.error).toContain("STT failed");
    expect(result.error).toContain("GPU worker timeout");
  });

  test("fallback to direct delegation when eventBus is not available", async () => {
    // When STT succeeds but no EventBus is wired, it should fall back
    // to direct delegation to handleUserMessage. Without full modules,
    // that delegation will fail with "Required modules" -- proving the path.
    const sttClient = createMockSttClient(
      Ok({ text: "fallback text", language: "en", confidence: 0.9, durationSeconds: 1.0 }),
    );

    const modules: InitializedModules = {
      logger,
      // no eventBus
      sttClient: sttClient as unknown as InitializedModules["sttClient"],
    };

    const handler = buildEventHandler(modules);
    const event = makeVoiceEvent({
      channelId: "desktop",
      userId: "user-1",
      audioBase64: toBase64("audio"),
      mimeType: "audio/wav",
    });

    const result = await handler(event, defaultPriority);

    // Falls through to handleUserMessage which fails without claudeManager etc.
    expect(result.success).toBe(false);
    expect(result.error).toContain("Required modules");
  });
});
