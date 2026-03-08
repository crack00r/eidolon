import { describe, expect, test } from "bun:test";
import {
  extractTraceContext,
  injectTraceContext,
  isValidTraceparent,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from "../propagation.ts";
import { NoopTracer } from "../tracer.ts";

describe("propagation constants", () => {
  test("TRACEPARENT_HEADER is correct", () => {
    expect(TRACEPARENT_HEADER).toBe("traceparent");
  });

  test("TRACESTATE_HEADER is correct", () => {
    expect(TRACESTATE_HEADER).toBe("tracestate");
  });
});

describe("injectTraceContext", () => {
  test("returns headers unchanged with NoopTracer (no trace context)", () => {
    const tracer = new NoopTracer();
    const headers: Record<string, string> = { Authorization: "Bearer token" };
    const result = injectTraceContext(tracer, headers);

    // NoopTracer returns empty headers, so only the original header remains
    expect(result.Authorization).toBe("Bearer token");
    expect(Object.keys(result)).toEqual(["Authorization"]);
  });

  test("modifies headers object in place", () => {
    const tracer = new NoopTracer();
    const headers: Record<string, string> = {};
    const result = injectTraceContext(tracer, headers);
    expect(result).toBe(headers); // same reference
  });
});

describe("extractTraceContext", () => {
  test("runs fn within extracted context and returns result", () => {
    const tracer = new NoopTracer();
    const result = extractTraceContext(tracer, {
      Traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    }, () => "hello");
    expect(result).toBe("hello");
  });

  test("normalizes header keys to lowercase", () => {
    const tracer = new NoopTracer();
    // NoopTracer.withExtractedContext just runs fn, so we verify no crash
    // and that the return value is propagated
    const result = extractTraceContext(tracer, {
      TRACEPARENT: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "X-Custom-Header": "value",
    }, () => 99);
    expect(result).toBe(99);
  });
});

describe("isValidTraceparent", () => {
  test("accepts valid traceparent", () => {
    expect(isValidTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01")).toBe(true);
  });

  test("accepts traceparent with all zeros trace flags", () => {
    expect(isValidTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00")).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidTraceparent("")).toBe(false);
  });

  test("rejects malformed traceparent (wrong number of parts)", () => {
    expect(isValidTraceparent("00-4bf92f3577b34da6a3ce929d0e0e4736-01")).toBe(false);
  });

  test("rejects traceparent with wrong trace-id length", () => {
    expect(isValidTraceparent("00-4bf92f35-00f067aa0ba902b7-01")).toBe(false);
  });

  test("rejects traceparent with uppercase hex", () => {
    expect(isValidTraceparent("00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01")).toBe(false);
  });

  test("rejects traceparent with non-hex characters", () => {
    expect(isValidTraceparent("00-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz-00f067aa0ba902b7-01")).toBe(false);
  });
});
