/**
 * Voice event handlers: user:voice, STT transcription, voice-to-message delegation.
 * Split from event-handlers.ts to keep files under 300 lines.
 */

import type { UserMessagePayload } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventHandlerResult } from "../loop/cognitive-loop.ts";
import { handleUserMessage } from "./event-handlers-user.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Handler: user:voice
// ---------------------------------------------------------------------------

export async function handleUserVoice(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  try {
    // Runtime-validate payload exists and is an object before casting
    if (typeof event.payload !== "object" || event.payload === null) {
      logger.warn("loop-handler", "Voice event has missing or non-object payload", { eventId: event.id });
      return { success: false, tokensUsed: 0, error: "Invalid voice event payload" };
    }
    const rawPayload = event.payload as Record<string, unknown>;
    const channelId = typeof rawPayload.channelId === "string" ? rawPayload.channelId : "voice";
    const userId = typeof rawPayload.userId === "string" ? rawPayload.userId : "unknown";
    const preTranscribedText = typeof rawPayload.text === "string" ? rawPayload.text : undefined;
    const audioBase64 = typeof rawPayload.audioBase64 === "string" ? rawPayload.audioBase64 : undefined;
    const mimeType = typeof rawPayload.mimeType === "string" ? rawPayload.mimeType : undefined;

    // Case 1: Pre-transcribed text available (client-side STT or test payload)
    if (preTranscribedText && preTranscribedText.trim().length > 0) {
      logger.info("loop-handler", "Voice input with pre-transcribed text, delegating to message handler", {
        eventId: event.id,
        textLength: preTranscribedText.length,
      });
      return delegateVoiceToMessage(modules, event.id, channelId, userId, preTranscribedText, logger);
    }

    // Case 2: Raw audio present -- run server-side STT via GPU worker
    if (audioBase64 && audioBase64.length > 0) {
      return handleVoiceAudioStt(modules, event.id, channelId, userId, audioBase64, mimeType, logger);
    }

    // Case 3: Neither text nor audio provided
    logger.warn("loop-handler", "Voice event received without audio or transcription", {
      eventId: event.id,
    });
    return { success: false, tokensUsed: 0, error: "Voice event has no audio data or transcription" };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `user:voice handler failed: ${errMsg}`);
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// Internal: decode base64 audio, run STT, and re-emit as user:message
// ---------------------------------------------------------------------------

async function handleVoiceAudioStt(
  modules: InitializedModules,
  eventId: string,
  channelId: string,
  userId: string,
  audioBase64: string,
  mimeType: string | undefined,
  logger: Logger,
): Promise<EventHandlerResult> {
  const sttClient = modules.sttClient;

  if (!sttClient) {
    logger.warn("loop-handler", "Voice audio received but STTClient not available (no GPU worker configured)", {
      eventId,
    });
    return { success: false, tokensUsed: 0, error: "STT unavailable: no GPU worker configured" };
  }

  logger.info("loop-handler", "Voice audio received, running STT transcription", {
    eventId,
    audioBase64Length: audioBase64.length,
    mimeType: mimeType ?? "audio/wav",
  });

  // Decode base64 audio to bytes
  let audioBytes: Uint8Array;
  try {
    const binaryStr = atob(audioBase64);
    audioBytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      audioBytes[i] = binaryStr.charCodeAt(i);
    }
  } catch (decodeErr: unknown) {
    const errMsg = decodeErr instanceof Error ? decodeErr.message : String(decodeErr);
    logger.error("loop-handler", `Failed to decode voice audio base64: ${errMsg}`, undefined, {
      eventId,
    });
    return { success: false, tokensUsed: 0, error: `Audio decode failed: ${errMsg}` };
  }

  // Send audio to GPU worker for transcription
  const sttResult = await sttClient.transcribe(audioBytes, mimeType ?? "audio/wav");

  if (!sttResult.ok) {
    logger.warn("loop-handler", `STT transcription failed: ${sttResult.error.message}`, {
      eventId,
      errorCode: sttResult.error.code,
    });
    return { success: false, tokensUsed: 0, error: `STT failed: ${sttResult.error.message}` };
  }

  const transcribedText = sttResult.value.text.trim();

  if (transcribedText.length === 0) {
    logger.debug("loop-handler", "STT returned empty transcription, skipping", {
      eventId,
      confidence: sttResult.value.confidence,
    });
    return { success: true, tokensUsed: 0 };
  }

  logger.info("loop-handler", "STT transcription completed", {
    eventId,
    textLength: transcribedText.length,
    language: sttResult.value.language,
    confidence: sttResult.value.confidence,
    durationSeconds: sttResult.value.durationSeconds,
  });

  // Re-emit as user:message on the EventBus so it flows through the standard pipeline
  if (modules.eventBus) {
    const messagePayload: UserMessagePayload = {
      channelId,
      userId,
      text: transcribedText,
    };
    modules.eventBus.publish("user:message", messagePayload, {
      priority: "high",
      source: "voice-stt",
    });
    return { success: true, tokensUsed: 0 };
  }

  // Fallback: if no EventBus, delegate directly to the text message handler
  return delegateVoiceToMessage(modules, eventId, channelId, userId, transcribedText, logger);
}

// ---------------------------------------------------------------------------
// Internal: create a synthetic user:message and process it via text handler
// ---------------------------------------------------------------------------

function delegateVoiceToMessage(
  modules: InitializedModules,
  eventId: string,
  channelId: string,
  userId: string,
  text: string,
  logger: Logger,
): Promise<EventHandlerResult> {
  const syntheticPayload: UserMessagePayload = { channelId, userId, text };
  return handleUserMessage(modules, { id: eventId, payload: syntheticPayload }, logger);
}
