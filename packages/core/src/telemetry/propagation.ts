/**
 * Trace context propagation helpers for cross-service communication.
 *
 * Supports W3C Trace Context (traceparent / tracestate headers) for
 * propagating trace context to the GPU Worker and extracting context
 * from incoming WebSocket messages.
 */

import type { ITracer } from "./tracer.ts";

// ---------------------------------------------------------------------------
// Header names (W3C Trace Context)
// ---------------------------------------------------------------------------

export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

// ---------------------------------------------------------------------------
// Injection -- add trace headers to outgoing requests
// ---------------------------------------------------------------------------

/**
 * Inject trace context headers into an outgoing HTTP request headers object.
 *
 * Used when Core makes requests to GPU Worker, so spans can be linked
 * across service boundaries.
 *
 * @param tracer  - The ITracer instance.
 * @param headers - Mutable headers object (will be modified in place).
 * @returns The headers object with trace context injected.
 */
export function injectTraceContext(tracer: ITracer, headers: Record<string, string>): Record<string, string> {
  const traceHeaders = tracer.getTraceHeaders();
  for (const [key, value] of Object.entries(traceHeaders)) {
    headers[key] = value;
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Extraction -- read trace headers from incoming requests
// ---------------------------------------------------------------------------

/**
 * Extract trace context from incoming HTTP or WebSocket message headers.
 *
 * Used when Gateway receives WebSocket messages that include trace context
 * from desktop/mobile clients.
 *
 * @param tracer  - The ITracer instance.
 * @param headers - Incoming headers (case-insensitive lookup performed).
 */
export function extractTraceContext(tracer: ITracer, headers: Record<string, string>): void {
  // Normalize header keys to lowercase for case-insensitive matching
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  tracer.extractContext(normalized);
}

// ---------------------------------------------------------------------------
// Validation helper
// ---------------------------------------------------------------------------

/** Regex for W3C traceparent header: version-trace_id-parent_id-trace_flags */
const TRACEPARENT_REGEX = /^[\da-f]{2}-[\da-f]{32}-[\da-f]{16}-[\da-f]{2}$/;

/**
 * Validate that a string is a well-formed W3C traceparent header.
 *
 * Format: `{version}-{trace-id}-{parent-id}-{trace-flags}`
 * Example: `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`
 */
export function isValidTraceparent(value: string): boolean {
  return TRACEPARENT_REGEX.test(value);
}
