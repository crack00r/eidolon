/**
 * TelemetryProvider -- initializes the OpenTelemetry SDK.
 *
 * When `config.telemetry.enabled` is true, creates a real TracerProvider
 * with OTLP HTTP exporters and returns an OTelTracer. Otherwise returns
 * a NoopTracer with zero runtime overhead.
 *
 * The provider must be shut down on daemon exit via `shutdown()` to flush
 * pending spans and metrics.
 */

import type { TelemetryConfig } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { ITracer } from "./tracer.ts";
import { NoopTracer, OTelTracer } from "./tracer.ts";

// ---------------------------------------------------------------------------
// TelemetryProvider
// ---------------------------------------------------------------------------

export interface TelemetryProvider {
  /** The tracer instance for creating spans. */
  readonly tracer: ITracer;
  /** Whether real OTel tracing is active. */
  readonly enabled: boolean;
  /** Flush pending data and shut down the SDK. */
  shutdown(): Promise<void>;
}

/** A provider that does nothing -- returned when telemetry is disabled. */
const NOOP_PROVIDER: TelemetryProvider = {
  tracer: new NoopTracer(),
  enabled: false,
  shutdown: async () => {
    /* no-op */
  },
};

/**
 * Initialize the OpenTelemetry provider.
 *
 * Dynamically imports the OTel SDK packages so they are not loaded
 * at all when telemetry is disabled.
 */
export async function initTelemetry(
  config: TelemetryConfig,
  logger: Logger,
): Promise<TelemetryProvider> {
  if (!config.enabled) {
    logger.info("telemetry", "Telemetry disabled (config.telemetry.enabled = false)");
    return NOOP_PROVIDER;
  }

  try {
    // Dynamic imports to avoid loading OTel SDK when disabled
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
    const { resourceFromAttributes } = await import("@opentelemetry/resources");
    const {
      ATTR_SERVICE_NAME,
      ATTR_SERVICE_VERSION,
    } = await import("@opentelemetry/semantic-conventions");
    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
    const { BatchSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    const { TraceIdRatioBasedSampler } = await import("@opentelemetry/sdk-trace-base");
    const otelApi = await import("@opentelemetry/api");

    // Build resource with service identity
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: "0.1.0",
      ...config.attributes,
    });

    // Trace exporter (OTLP over HTTP)
    const traceExporter = new OTLPTraceExporter({
      url: `${config.endpoint}/v1/traces`,
    });

    // Metric exporter (OTLP over HTTP)
    const metricExporter = new OTLPMetricExporter({
      url: `${config.endpoint}/v1/metrics`,
    });

    // Sampler
    const sampler = new TraceIdRatioBasedSampler(config.sampleRate);

    // Create the SDK
    const sdk = new NodeSDK({
      resource,
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
      metricReader: new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: config.exportIntervalMs,
      }),
      sampler,
    });

    sdk.start();

    // Get a tracer from the global provider
    const tracer = otelApi.trace.getTracer(config.serviceName, "0.1.0");

    logger.info("telemetry", "OpenTelemetry initialized", {
      endpoint: config.endpoint,
      serviceName: config.serviceName,
      sampleRate: config.sampleRate,
      protocol: config.protocol,
    });

    return {
      tracer: new OTelTracer(tracer),
      enabled: true,
      shutdown: async () => {
        try {
          await sdk.shutdown();
          logger.info("telemetry", "OpenTelemetry SDK shut down");
        } catch (err: unknown) {
          logger.error("telemetry", "Error shutting down OpenTelemetry SDK", err);
        }
      },
    };
  } catch (err: unknown) {
    logger.error("telemetry", "Failed to initialize OpenTelemetry, falling back to NoopTracer", err);
    return NOOP_PROVIDER;
  }
}
