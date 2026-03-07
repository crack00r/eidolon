/**
 * GPU worker pool request validation helpers.
 *
 * Extracted from pool.ts to keep file sizes manageable.
 * Validates TTS and STT requests before dispatching to workers.
 */

import type { EidolonError } from "@eidolon/protocol";
import { createError, ErrorCode } from "@eidolon/protocol";
import type { TtsRequest } from "./tts-client.ts";

// ---------------------------------------------------------------------------
// TTS validation constants
// ---------------------------------------------------------------------------

/** Maximum allowed text length for a single TTS request. */
const MAX_TTS_TEXT_LENGTH = 10_000;

/** Valid TTS speed range. */
const MIN_TTS_SPEED = 0.25;
const MAX_TTS_SPEED = 4.0;

/** Valid TTS output formats. */
const VALID_TTS_FORMATS: ReadonlySet<string> = new Set(["opus", "wav", "mp3"]);

/** Maximum voice parameter length. */
const MAX_VOICE_LENGTH = 64;

/** Allowed characters in voice parameter. */
const VOICE_PATTERN = /^[a-zA-Z0-9_\-.]+$/;

// ---------------------------------------------------------------------------
// STT validation constants
// ---------------------------------------------------------------------------

/** Maximum allowed audio size for a single STT request: 25 MB. */
export const MAX_STT_AUDIO_BYTES = 25 * 1024 * 1024;

/** Timeout for STT upload requests (60 seconds). */
export const STT_UPLOAD_TIMEOUT_MS = 60_000;

/** Supported MIME types for STT audio input. */
const ALLOWED_STT_MIME_TYPES: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
]);

// ---------------------------------------------------------------------------
// Validation functions
// ---------------------------------------------------------------------------

/** Validate a TTS request. Returns null if valid, or an EidolonError if invalid. */
export function validateTtsRequest(request: TtsRequest): EidolonError | null {
  if (request.text.length === 0) {
    return createError(ErrorCode.TTS_FAILED, "TTS text is empty");
  }
  if (request.text.length > MAX_TTS_TEXT_LENGTH) {
    return createError(
      ErrorCode.TTS_FAILED,
      `TTS text too long: ${request.text.length} characters (max ${MAX_TTS_TEXT_LENGTH})`,
    );
  }
  if (request.speed !== undefined && (request.speed < MIN_TTS_SPEED || request.speed > MAX_TTS_SPEED)) {
    return createError(
      ErrorCode.TTS_FAILED,
      `TTS speed out of range: ${request.speed} (must be ${MIN_TTS_SPEED}-${MAX_TTS_SPEED})`,
    );
  }
  if (request.format !== undefined && !VALID_TTS_FORMATS.has(request.format)) {
    return createError(ErrorCode.TTS_FAILED, `Invalid TTS format: ${request.format}`);
  }
  if (request.voice !== undefined) {
    if (request.voice.length === 0 || request.voice.length > MAX_VOICE_LENGTH) {
      return createError(
        ErrorCode.TTS_FAILED,
        `Invalid TTS voice length: ${request.voice.length} (must be 1-${MAX_VOICE_LENGTH})`,
      );
    }
    if (!VOICE_PATTERN.test(request.voice)) {
      return createError(
        ErrorCode.TTS_FAILED,
        "Invalid TTS voice: contains disallowed characters (only alphanumeric, hyphens, underscores, dots allowed)",
      );
    }
  }
  return null;
}

/** Validate an STT request. Returns null if valid, or an EidolonError if invalid. */
export function validateSttRequest(audio: Uint8Array, mimeType?: string): EidolonError | null {
  if (audio.byteLength === 0) {
    return createError(ErrorCode.STT_FAILED, "STT audio is empty");
  }
  if (audio.byteLength > MAX_STT_AUDIO_BYTES) {
    return createError(
      ErrorCode.STT_FAILED,
      `STT audio too large: ${audio.byteLength} bytes (max ${MAX_STT_AUDIO_BYTES})`,
    );
  }
  const mime = mimeType ?? "audio/wav";
  if (!ALLOWED_STT_MIME_TYPES.has(mime)) {
    return createError(ErrorCode.STT_FAILED, `Unsupported audio MIME type: ${mime}`);
  }
  return null;
}
