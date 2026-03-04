/**
 * Tracer abstraction for OpenTelemetry integration.
 *
 * Provides ITracer and ISpan interfaces that decouple business logic
 * from the OTel SDK. When telemetry is disabled, NoopTracer is used
 * so all tracing calls are zero-cost no-ops.
 */

import type { Span, Tracer } from "@opentelemetry/api";
import { SpanStatusCode, context, propagation, trace } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Attribute value type
// ---------------------------------------------------------------------------

/** Allowed values for span attributes. */
export type SpanAttributeValue = string | number | boolean;

// ---------------------------------------------------------------------------
// ISpan -- thin wrapper around OTel Span
// ---------------------------------------------------------------------------

export interface ISpan {
  /** Set a single attribute on this span. */
  setAttribute(key: string, value: SpanAttributeValue): void;
  /** Set the span status to ok or error. */
  setStatus(code: "ok" | "error", message?: string): void;
  /** Add a timestamped event to this span. */
  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): void;
  /** End the span (must be called exactly once). */
  end(): void;
}

// ---------------------------------------------------------------------------
// ITracer -- the abstraction used by all instrumented code
// ---------------------------------------------------------------------------

export interface ITracer {
  /** Create a span, run `fn` within it, and end the span when done. */
  withSpan<T>(
    name: string,
    attributes: Record<string, SpanAttributeValue>,
    fn: () => Promise<T>,
  ): Promise<T>;

  /** Create a span manually. Caller MUST call `span.end()`. */
  startSpan(name: string, attributes?: Record<string, SpanAttributeValue>): ISpan;

  /** Get W3C traceparent headers for propagating context to external services. */
  getTraceHeaders(): Record<string, string>;

  /** Extract trace context from incoming headers into the current context. */
  extractContext(headers: Record<string, string>): void;
}

// ---------------------------------------------------------------------------
// NoopSpan
// ---------------------------------------------------------------------------

export class NoopSpan implements ISpan {
  setAttribute(_key: string, _value: SpanAttributeValue): void {
    /* no-op */
  }

  setStatus(_code: "ok" | "error", _message?: string): void {
    /* no-op */
  }

  addEvent(_name: string, _attributes?: Record<string, SpanAttributeValue>): void {
    /* no-op */
  }

  end(): void {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// NoopTracer
// ---------------------------------------------------------------------------

/** No-op tracer returned when telemetry is disabled. Zero overhead. */
export class NoopTracer implements ITracer {
  async withSpan<T>(
    _name: string,
    _attributes: Record<string, SpanAttributeValue>,
    fn: () => Promise<T>,
  ): Promise<T> {
    return fn();
  }

  startSpan(_name: string, _attributes?: Record<string, SpanAttributeValue>): ISpan {
    return new NoopSpan();
  }

  getTraceHeaders(): Record<string, string> {
    return {};
  }

  extractContext(_headers: Record<string, string>): void {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// OTelSpan -- wraps a real OpenTelemetry Span
// ---------------------------------------------------------------------------

export class OTelSpan implements ISpan {
  private readonly span: Span;

  constructor(span: Span) {
    this.span = span;
  }

  setAttribute(key: string, value: SpanAttributeValue): void {
    this.span.setAttribute(key, value);
  }

  setStatus(code: "ok" | "error", message?: string): void {
    this.span.setStatus({
      code: code === "ok" ? SpanStatusCode.OK : SpanStatusCode.ERROR,
      message,
    });
  }

  addEvent(name: string, attributes?: Record<string, SpanAttributeValue>): void {
    this.span.addEvent(name, attributes);
  }

  end(): void {
    this.span.end();
  }
}

// ---------------------------------------------------------------------------
// OTelTracer -- wraps a real OpenTelemetry Tracer
// ---------------------------------------------------------------------------

/** Real tracer backed by the OpenTelemetry SDK. */
export class OTelTracer implements ITracer {
  private readonly tracer: Tracer;

  constructor(tracer: Tracer) {
    this.tracer = tracer;
  }

  async withSpan<T>(
    name: string,
    attributes: Record<string, SpanAttributeValue>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const span = this.tracer.startSpan(name, { attributes });
    const ctx = trace.setSpan(context.active(), span);

    try {
      const result = await context.with(ctx, fn);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err: unknown) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  }

  startSpan(name: string, attributes?: Record<string, SpanAttributeValue>): ISpan {
    const span = this.tracer.startSpan(name, { attributes });
    return new OTelSpan(span);
  }

  getTraceHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    propagation.inject(context.active(), headers);
    return headers;
  }

  extractContext(headers: Record<string, string>): void {
    propagation.extract(context.active(), headers);
  }
}
