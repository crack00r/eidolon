/**
 * Tests for Wyoming protocol parser and serializer.
 */

import { describe, expect, it } from "bun:test";
import { WyomingParser, serializeEvent } from "../protocol.ts";
import type { WyomingEvent } from "../protocol.ts";

// ---------------------------------------------------------------------------
// serializeEvent
// ---------------------------------------------------------------------------

describe("serializeEvent", () => {
  it("serializes event without payload", () => {
    const event: WyomingEvent = {
      type: "ping",
      data: {},
      payload: null,
    };
    const bytes = serializeEvent(event);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;

    expect(parsed.type).toBe("ping");
    expect(parsed.payload_length).toBe(0);
  });

  it("serializes event with binary payload", () => {
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const event: WyomingEvent = {
      type: "audio-chunk",
      data: { rate: 16_000, width: 2, channels: 1 },
      payload,
    };
    const bytes = serializeEvent(event);

    // Find the newline to separate header from payload
    let nlIndex = -1;
    for (let i = 0; i < bytes.byteLength; i++) {
      if (bytes[i] === 0x0a) {
        nlIndex = i;
        break;
      }
    }
    expect(nlIndex).toBeGreaterThan(0);

    const headerText = new TextDecoder().decode(bytes.slice(0, nlIndex));
    const header = JSON.parse(headerText) as Record<string, unknown>;
    expect(header.type).toBe("audio-chunk");
    expect(header.payload_length).toBe(4);

    // Check binary payload
    const binaryPayload = bytes.slice(nlIndex + 1);
    expect(binaryPayload).toEqual(payload);
  });

  it("serializes transcript event with text data", () => {
    const event: WyomingEvent = {
      type: "transcript",
      data: { text: "Hello world" },
      payload: null,
    };
    const bytes = serializeEvent(event);
    const text = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;

    expect(parsed.type).toBe("transcript");
    const data = parsed.data as Record<string, unknown>;
    expect(data.text).toBe("Hello world");
  });
});

// ---------------------------------------------------------------------------
// WyomingParser
// ---------------------------------------------------------------------------

describe("WyomingParser", () => {
  it("parses a complete event without payload", () => {
    const parser = new WyomingParser();
    const header = JSON.stringify({ type: "ping", data: {}, payload_length: 0 });
    const bytes = new TextEncoder().encode(header + "\n");

    const result = parser.feed(bytes);
    expect(result.ok).toBe(true);

    const events = parser.take();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("ping");
    expect(events[0]?.payload).toBeNull();
  });

  it("parses event with binary payload", () => {
    const parser = new WyomingParser();
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc]);
    const header = JSON.stringify({
      type: "audio-chunk",
      data: { rate: 16_000, width: 2, channels: 1 },
      payload_length: 3,
    });

    const headerBytes = new TextEncoder().encode(header + "\n");
    const fullData = new Uint8Array(headerBytes.byteLength + 3);
    fullData.set(headerBytes, 0);
    fullData.set(payload, headerBytes.byteLength);

    const result = parser.feed(fullData);
    expect(result.ok).toBe(true);

    const events = parser.take();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("audio-chunk");
    expect(events[0]?.payload).toEqual(payload);
  });

  it("handles partial header across multiple feeds", () => {
    const parser = new WyomingParser();
    const header = JSON.stringify({ type: "pong", data: {}, payload_length: 0 }) + "\n";
    const bytes = new TextEncoder().encode(header);

    // Feed first half
    const half = Math.floor(bytes.byteLength / 2);
    const result1 = parser.feed(bytes.slice(0, half));
    expect(result1.ok).toBe(true);
    expect(parser.take()).toHaveLength(0);

    // Feed second half
    const result2 = parser.feed(bytes.slice(half));
    expect(result2.ok).toBe(true);
    const events = parser.take();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("pong");
  });

  it("handles partial payload across multiple feeds", () => {
    const parser = new WyomingParser();
    const payload = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const header = JSON.stringify({
      type: "audio-chunk",
      data: { rate: 16_000, width: 2, channels: 1 },
      payload_length: 4,
    });

    // Feed header + partial payload
    const headerBytes = new TextEncoder().encode(header + "\n");
    const partial = new Uint8Array(headerBytes.byteLength + 2);
    partial.set(headerBytes, 0);
    partial.set(payload.slice(0, 2), headerBytes.byteLength);

    const result1 = parser.feed(partial);
    expect(result1.ok).toBe(true);
    expect(parser.take()).toHaveLength(0);

    // Feed remaining payload
    const result2 = parser.feed(payload.slice(2));
    expect(result2.ok).toBe(true);

    const events = parser.take();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual(payload);
  });

  it("parses multiple events in a single feed", () => {
    const parser = new WyomingParser();
    const event1 = JSON.stringify({ type: "ping", data: {}, payload_length: 0 }) + "\n";
    const event2 = JSON.stringify({ type: "pong", data: {}, payload_length: 0 }) + "\n";
    const bytes = new TextEncoder().encode(event1 + event2);

    const result = parser.feed(bytes);
    expect(result.ok).toBe(true);

    const events = parser.take();
    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("ping");
    expect(events[1]?.type).toBe("pong");
  });

  it("rejects invalid JSON", () => {
    const parser = new WyomingParser();
    const bytes = new TextEncoder().encode("{invalid json}\n");

    const result = parser.feed(bytes);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("WYOMING_PROTOCOL_ERROR");
    }
  });

  it("rejects header missing type field", () => {
    const parser = new WyomingParser();
    const bytes = new TextEncoder().encode(JSON.stringify({ data: {} }) + "\n");

    const result = parser.feed(bytes);
    expect(result.ok).toBe(false);
  });

  it("skips empty lines", () => {
    const parser = new WyomingParser();
    const header = JSON.stringify({ type: "ping", data: {}, payload_length: 0 });
    const bytes = new TextEncoder().encode("\n\n" + header + "\n");

    const result = parser.feed(bytes);
    expect(result.ok).toBe(true);

    const events = parser.take();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("ping");
  });

  it("take() clears the event queue", () => {
    const parser = new WyomingParser();
    const bytes = new TextEncoder().encode(
      JSON.stringify({ type: "ping", data: {}, payload_length: 0 }) + "\n",
    );

    parser.feed(bytes);
    expect(parser.take()).toHaveLength(1);
    expect(parser.take()).toHaveLength(0);
  });

  it("roundtrips serialize -> parse", () => {
    const parser = new WyomingParser();
    const originalEvent: WyomingEvent = {
      type: "transcript",
      data: { text: "Hello world" },
      payload: null,
    };

    const serialized = serializeEvent(originalEvent);
    const result = parser.feed(serialized);
    expect(result.ok).toBe(true);

    const events = parser.take();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("transcript");
    const data = events[0]?.data as Record<string, unknown>;
    expect(data.text).toBe("Hello world");
  });

  it("roundtrips serialize -> parse with binary payload", () => {
    const parser = new WyomingParser();
    const payload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const originalEvent: WyomingEvent = {
      type: "audio-chunk",
      data: { rate: 16_000, width: 2, channels: 1 },
      payload,
    };

    const serialized = serializeEvent(originalEvent);
    const result = parser.feed(serialized);
    expect(result.ok).toBe(true);

    const events = parser.take();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual(payload);
  });
});
