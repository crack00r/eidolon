// Telemetry module -- OpenTelemetry distributed tracing integration.
export { initTelemetry } from "./provider.ts";
export type { TelemetryProvider } from "./provider.ts";
export { NoopTracer, NoopSpan, OTelTracer, OTelSpan } from "./tracer.ts";
export type { ITracer, ISpan, SpanAttributeValue } from "./tracer.ts";
export { createMetricsBridge } from "./metrics-bridge.ts";
export type { MetricsBridgeHandle } from "./metrics-bridge.ts";
export {
  injectTraceContext,
  extractTraceContext,
  isValidTraceparent,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from "./propagation.ts";
