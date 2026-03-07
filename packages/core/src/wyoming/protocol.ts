/**
 * Wyoming protocol event parser and serializer.
 *
 * The Wyoming protocol is a JSON-line protocol used by Home Assistant
 * for voice satellites. Each message consists of a JSON header line
 * followed by optional binary payload.
 *
 * Header format: {"type": "<event-type>", "data": {...}, "data_length": <n>, "payload_length": <n>}
 * Binary payload follows immediately after the newline.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum header line size (64 KB). */
const MAX_HEADER_SIZE = 64 * 1024;

/** Maximum binary payload size (10 MB). */
const MAX_PAYLOAD_SIZE = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Wyoming Event Types
// ---------------------------------------------------------------------------

export const WYOMING_EVENT_TYPES = [
  "run-satellite",
  "detect",
  "detection",
  "transcript",
  "synthesize",
  "audio-start",
  "audio-chunk",
  "audio-stop",
  "voice-started",
  "voice-stopped",
  "describe",
  "info",
  "error",
  "ping",
  "pong",
  "not-handled",
] as const;

export type WyomingEventType = (typeof WYOMING_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Zod Schemas for event data
// ---------------------------------------------------------------------------

export const AudioStartDataSchema = z.object({
  rate: z.number().int().min(8_000).max(48_000),
  width: z.number().int().min(1).max(4),
  channels: z.number().int().min(1).max(2),
});

export const AudioChunkDataSchema = z.object({
  rate: z.number().int().min(8_000).max(48_000),
  width: z.number().int().min(1).max(4),
  channels: z.number().int().min(1).max(2),
});

export const TranscriptDataSchema = z.object({
  text: z.string(),
});

export const SynthesizeDataSchema = z.object({
  text: z.string().min(1),
  voice: z.string().optional(),
});

export const DetectionDataSchema = z.object({
  name: z.string().optional(),
  timestamp: z.number().optional(),
});

export const DescribeDataSchema = z.object({});

export const InfoDataSchema = z.object({
  asr: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        attribution: z.object({ name: z.string(), url: z.string() }).optional(),
        installed: z.boolean().optional(),
        languages: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  tts: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        attribution: z.object({ name: z.string(), url: z.string() }).optional(),
        installed: z.boolean().optional(),
        languages: z.array(z.string()).optional(),
        voices: z
          .array(
            z.object({
              name: z.string(),
              description: z.string().optional(),
              languages: z.array(z.string()).optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
  intent: z
    .array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        attribution: z.object({ name: z.string(), url: z.string() }).optional(),
        installed: z.boolean().optional(),
        languages: z.array(z.string()).optional(),
      }),
    )
    .optional(),
});

export const ErrorDataSchema = z.object({
  text: z.string(),
  code: z.string().optional(),
});

export const PingDataSchema = z.object({});
export const PongDataSchema = z.object({});

// ---------------------------------------------------------------------------
// Wyoming Event
// ---------------------------------------------------------------------------

export interface WyomingEvent {
  readonly type: WyomingEventType;
  readonly data: Record<string, unknown>;
  readonly payload: Uint8Array | null;
}

// ---------------------------------------------------------------------------
// Header schema (the JSON line)
// ---------------------------------------------------------------------------

const WyomingHeaderSchema = z.object({
  type: z.string(),
  data: z.record(z.unknown()).optional(),
  data_length: z.number().int().min(0).optional(),
  payload_length: z.number().int().min(0).max(MAX_PAYLOAD_SIZE).optional(),
});

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

/**
 * Serialize a Wyoming event into a Buffer ready to send over TCP.
 * Format: JSON header line + newline + optional binary payload.
 */
export function serializeEvent(event: WyomingEvent): Uint8Array {
  const payloadLength = event.payload?.byteLength ?? 0;

  const header = JSON.stringify({
    type: event.type,
    data: event.data,
    data_length: 0,
    payload_length: payloadLength,
  });

  const headerBytes = new TextEncoder().encode(`${header}\n`);

  if (payloadLength === 0 || event.payload === null) {
    return headerBytes;
  }

  const result = new Uint8Array(headerBytes.byteLength + payloadLength);
  result.set(headerBytes, 0);
  result.set(event.payload, headerBytes.byteLength);
  return result;
}

// ---------------------------------------------------------------------------
// Parser (streaming, stateful)
// ---------------------------------------------------------------------------

export type ParseResult = Result<WyomingEvent, EidolonError>;

/**
 * Streaming Wyoming protocol parser.
 *
 * Feed raw TCP data via `feed()` and pull parsed events via `take()`.
 * Handles partial reads and binary payloads correctly.
 */
export class WyomingParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private readonly events: WyomingEvent[] = [];

  /** Pending header waiting for its binary payload. */
  private pendingHeader: { type: string; data: Record<string, unknown>; payloadLength: number } | null = null;

  /** Feed raw bytes from the TCP socket. */
  feed(data: Uint8Array): Result<void, EidolonError> {
    // Append data to buffer
    const newBuffer = new Uint8Array(this.buffer.byteLength + data.byteLength);
    newBuffer.set(this.buffer, 0);
    newBuffer.set(data, this.buffer.byteLength);
    this.buffer = newBuffer;

    // Guard against oversized buffers
    if (this.buffer.byteLength > MAX_HEADER_SIZE + MAX_PAYLOAD_SIZE) {
      return Err(createError(ErrorCode.WYOMING_PROTOCOL_ERROR, "Wyoming buffer exceeded maximum size"));
    }

    // Parse as many complete events as possible
    return this.parseBuffer();
  }

  /** Take all parsed events, clearing the internal queue. */
  take(): readonly WyomingEvent[] {
    const result = [...this.events];
    this.events.length = 0;
    return result;
  }

  /** Parse complete events from the buffer. */
  private parseBuffer(): Result<void, EidolonError> {
    for (;;) {
      if (this.pendingHeader !== null) {
        // We're waiting for binary payload
        if (this.buffer.byteLength < this.pendingHeader.payloadLength) {
          return Ok(undefined); // Need more data
        }

        const payload = this.buffer.slice(0, this.pendingHeader.payloadLength);
        this.buffer = this.buffer.slice(this.pendingHeader.payloadLength);

        this.events.push({
          type: this.pendingHeader.type as WyomingEventType,
          data: this.pendingHeader.data,
          payload,
        });
        this.pendingHeader = null;
        continue;
      }

      // Look for newline (end of JSON header)
      const nlIndex = findNewline(this.buffer);
      if (nlIndex === -1) {
        if (this.buffer.byteLength > MAX_HEADER_SIZE) {
          return Err(createError(ErrorCode.WYOMING_PROTOCOL_ERROR, "Wyoming header line too long"));
        }
        return Ok(undefined); // Need more data
      }

      const headerLine = new TextDecoder().decode(this.buffer.slice(0, nlIndex));
      this.buffer = this.buffer.slice(nlIndex + 1);

      // Skip empty lines
      if (headerLine.trim().length === 0) continue;

      // Parse JSON header
      const parseResult = parseHeader(headerLine);
      if (!parseResult.ok) return parseResult;

      const header = parseResult.value;
      const payloadLength = header.payload_length ?? 0;

      if (payloadLength > 0) {
        // Need to read binary payload
        this.pendingHeader = {
          type: header.type,
          data: header.data ?? {},
          payloadLength,
        };
        continue;
      }

      // No payload -- event is complete
      this.events.push({
        type: header.type as WyomingEventType,
        data: header.data ?? {},
        payload: null,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findNewline(data: Uint8Array): number {
  for (let i = 0; i < data.byteLength; i++) {
    if (data[i] === 0x0a) return i;
  }
  return -1;
}

function parseHeader(line: string): Result<z.infer<typeof WyomingHeaderSchema>, EidolonError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return Err(createError(ErrorCode.WYOMING_PROTOCOL_ERROR, `Invalid JSON in Wyoming header: ${line.slice(0, 200)}`));
  }

  const result = WyomingHeaderSchema.safeParse(parsed);
  if (!result.success) {
    return Err(createError(ErrorCode.WYOMING_PROTOCOL_ERROR, `Invalid Wyoming header: ${result.error.message}`));
  }

  return Ok(result.data);
}
