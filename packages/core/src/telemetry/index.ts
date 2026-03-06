// Telemetry module -- OpenTelemetry distributed tracing integration.

export type { MetricsBridgeHandle } from "./metrics-bridge.ts";
export { createMetricsBridge } from "./metrics-bridge.ts";
export {
  extractTraceContext,
  injectTraceContext,
  isValidTraceparent,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from "./propagation.ts";
export type { TelemetryProvider } from "./provider.ts";
export { initTelemetry } from "./provider.ts";
export type { ISpan, ITracer, SpanAttributeValue } from "./tracer.ts";
export { NoopSpan, NoopTracer, OTelSpan, OTelTracer } from "./tracer.ts";
