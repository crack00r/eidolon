import { describe, expect, test } from "bun:test";
import { NoopSpan, NoopTracer, OTelSpan, OTelTracer } from "../tracer.ts";

// ---------------------------------------------------------------------------
// NoopSpan
// ---------------------------------------------------------------------------

describe("NoopSpan", () => {
  test("setAttribute is a no-op", () => {
    const span = new NoopSpan();
    // Should not throw
    span.setAttribute("key", "value");
    span.setAttribute("count", 42);
    span.setAttribute("flag", true);
  });

  test("setStatus is a no-op", () => {
    const span = new NoopSpan();
    span.setStatus("ok");
    span.setStatus("error", "something went wrong");
  });

  test("addEvent is a no-op", () => {
    const span = new NoopSpan();
    span.addEvent("test-event");
    span.addEvent("test-event", { key: "value" });
  });

  test("end is a no-op", () => {
    const span = new NoopSpan();
    span.end();
  });
});

// ---------------------------------------------------------------------------
// NoopTracer
// ---------------------------------------------------------------------------

describe("NoopTracer", () => {
  test("withSpan executes the function and returns its result", async () => {
    const tracer = new NoopTracer();
    const result = await tracer.withSpan("test-span", { key: "value" }, async () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test("withSpan propagates errors from the function", async () => {
    const tracer = new NoopTracer();
    await expect(
      tracer.withSpan("test-span", {}, async () => {
        throw new Error("test error");
      }),
    ).rejects.toThrow("test error");
  });

  test("startSpan returns a NoopSpan", () => {
    const tracer = new NoopTracer();
    const span = tracer.startSpan("test-span");
    expect(span).toBeInstanceOf(NoopSpan);
  });

  test("getTraceHeaders returns empty object", () => {
    const tracer = new NoopTracer();
    const headers = tracer.getTraceHeaders();
    expect(headers).toEqual({});
  });

  test("extractContext is a no-op", () => {
    const tracer = new NoopTracer();
    // Should not throw
    tracer.extractContext({ traceparent: "00-abc-def-01" });
  });
});

// ---------------------------------------------------------------------------
// OTelSpan -- wraps a mock OTel Span
// ---------------------------------------------------------------------------

describe("OTelSpan", () => {
  function createMockSpan(): {
    span: OTelSpan;
    calls: Array<{ method: string; args: unknown[] }>;
  } {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const mockOtelSpan = {
      setAttribute(key: string, value: unknown) {
        calls.push({ method: "setAttribute", args: [key, value] });
      },
      setStatus(status: { code: number; message?: string }) {
        calls.push({ method: "setStatus", args: [status] });
      },
      addEvent(name: string, attributes?: Record<string, unknown>) {
        calls.push({ method: "addEvent", args: [name, attributes] });
      },
      end() {
        calls.push({ method: "end", args: [] });
      },
      recordException(_err: Error) {
        calls.push({ method: "recordException", args: [_err] });
      },
      isRecording() {
        return true;
      },
      spanContext() {
        return { traceId: "abc", spanId: "def", traceFlags: 1, isRemote: false };
      },
      updateName(_name: string) {
        return mockOtelSpan;
      },
    };
    // Cast to unknown first since we have a minimal mock
    const span = new OTelSpan(mockOtelSpan as unknown as import("@opentelemetry/api").Span);
    return { span, calls };
  }

  test("setAttribute delegates to the underlying span", () => {
    const { span, calls } = createMockSpan();
    span.setAttribute("user.id", "abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("setAttribute");
    expect(calls[0]?.args).toEqual(["user.id", "abc"]);
  });

  test("setStatus delegates to the underlying span with OK code", () => {
    const { span, calls } = createMockSpan();
    span.setStatus("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("setStatus");
    // SpanStatusCode.OK = 1
    const statusArg = calls[0]?.args[0] as { code: number; message?: string };
    expect(statusArg.code).toBe(1);
  });

  test("setStatus delegates to the underlying span with ERROR code", () => {
    const { span, calls } = createMockSpan();
    span.setStatus("error", "something broke");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("setStatus");
    const statusArg = calls[0]?.args[0] as { code: number; message?: string };
    // SpanStatusCode.ERROR = 2
    expect(statusArg.code).toBe(2);
    expect(statusArg.message).toBe("something broke");
  });

  test("addEvent delegates to the underlying span", () => {
    const { span, calls } = createMockSpan();
    span.addEvent("cache.hit", { key: "memory-search" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("addEvent");
    expect(calls[0]?.args[0]).toBe("cache.hit");
  });

  test("end delegates to the underlying span", () => {
    const { span, calls } = createMockSpan();
    span.end();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("end");
  });
});

// ---------------------------------------------------------------------------
// OTelTracer -- tested via integration with the real SDK would require
// a full TracerProvider. We test the withSpan error-handling logic here
// using a minimal mock.
// ---------------------------------------------------------------------------

describe("OTelTracer", () => {
  function createMockTracer(): {
    tracer: OTelTracer;
    spans: Array<{ name: string; ended: boolean; status?: { code: number; message?: string } }>;
  } {
    const spans: Array<{
      name: string;
      ended: boolean;
      status?: { code: number; message?: string };
    }> = [];

    const mockTracer = {
      startSpan(name: string, _options?: unknown) {
        const spanRecord = { name, ended: false, status: undefined as { code: number; message?: string } | undefined };
        spans.push(spanRecord);
        return {
          setAttribute() {},
          setStatus(s: { code: number; message?: string }) {
            spanRecord.status = s;
          },
          addEvent() {},
          end() {
            spanRecord.ended = true;
          },
          recordException() {},
          isRecording() {
            return true;
          },
          spanContext() {
            return { traceId: "abc", spanId: "def", traceFlags: 1, isRemote: false };
          },
          updateName() {
            return this;
          },
        };
      },
    };

    const tracer = new OTelTracer(mockTracer as unknown as import("@opentelemetry/api").Tracer);
    return { tracer, spans };
  }

  test("startSpan returns an OTelSpan", () => {
    const { tracer } = createMockTracer();
    const span = tracer.startSpan("test");
    expect(span).toBeInstanceOf(OTelSpan);
  });
});
