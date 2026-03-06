/**
 * MetricsBridge -- bridges the existing MetricsRegistry to the OTel Metrics API.
 *
 * The MetricsRegistry in prometheus.ts is the single source of truth for
 * metrics. This bridge periodically reads metric values from the registry
 * and reports them to the OTel MeterProvider so they can be exported via
 * OTLP alongside traces.
 *
 * When telemetry is disabled, `createMetricsBridge()` returns a no-op handle.
 */

import type { Logger } from "../logging/logger.ts";
import type { MetricsRegistry } from "../metrics/prometheus.ts";

// ---------------------------------------------------------------------------
// Bridge handle
// ---------------------------------------------------------------------------

export interface MetricsBridgeHandle {
  /** Stop the periodic sync and clean up. */
  dispose(): void;
}

const NOOP_HANDLE: MetricsBridgeHandle = {
  dispose: () => {
    /* no-op */
  },
};

// ---------------------------------------------------------------------------
// Default sync interval
// ---------------------------------------------------------------------------

const DEFAULT_SYNC_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// createMetricsBridge
// ---------------------------------------------------------------------------

/**
 * Create a bridge that periodically syncs MetricsRegistry values to
 * OTel observable instruments.
 *
 * @param registry - The existing Prometheus-style MetricsRegistry.
 * @param enabled  - Whether OTel telemetry is enabled.
 * @param logger   - Logger instance.
 * @param syncIntervalMs - How often to sync (default: 10s).
 */
export async function createMetricsBridge(
  registry: MetricsRegistry,
  enabled: boolean,
  logger: Logger,
  syncIntervalMs: number = DEFAULT_SYNC_INTERVAL_MS,
): Promise<MetricsBridgeHandle> {
  if (!enabled) {
    return NOOP_HANDLE;
  }

  try {
    const otelApi = await import("@opentelemetry/api");
    const meter = otelApi.metrics.getMeter("eidolon-core-bridge", "0.1.0");

    // Create observable instruments that read from the registry on demand
    const eventsCounter = meter.createObservableCounter("eidolon.events_processed_total", {
      description: "Total events processed by the cognitive loop",
    });
    eventsCounter.addCallback((result) => {
      const value = registry.eventsProcessed.values.get("") ?? 0;
      result.observe(value);
    });

    const activeSessions = meter.createObservableGauge("eidolon.active_sessions", {
      description: "Number of currently active sessions",
    });
    activeSessions.addCallback((result) => {
      const value = registry.activeSessions.values.get("") ?? 0;
      result.observe(value);
    });

    const queueDepth = meter.createObservableGauge("eidolon.event_queue_depth", {
      description: "Number of unprocessed events in the event queue",
    });
    queueDepth.addCallback((result) => {
      const value = registry.eventQueueDepth.values.get("") ?? 0;
      result.observe(value);
    });

    const costCounter = meter.createObservableCounter("eidolon.cost_usd_total", {
      description: "Total cost in USD",
    });
    costCounter.addCallback((result) => {
      const value = registry.costUsd.values.get("") ?? 0;
      result.observe(value);
    });

    const tokensCounter = meter.createObservableCounter("eidolon.tokens_used_total", {
      description: "Total tokens used by model",
    });
    tokensCounter.addCallback((result) => {
      for (const [model, value] of registry.tokensUsed.values.entries()) {
        result.observe(value, { model });
      }
    });

    const loopCycleCount = meter.createObservableCounter("eidolon.loop_cycle_count", {
      description: "Total cognitive loop cycles",
    });
    loopCycleCount.addCallback((result) => {
      result.observe(registry.loopCycleTime.count);
    });

    const loopCycleSum = meter.createObservableCounter("eidolon.loop_cycle_duration_sum_ms", {
      description: "Sum of cognitive loop cycle durations in milliseconds",
    });
    loopCycleSum.addCallback((result) => {
      result.observe(registry.loopCycleTime.sum);
    });

    logger.info("telemetry", "MetricsBridge initialized", { syncIntervalMs });

    // The OTel SDK handles periodic collection via the MetricReader,
    // so we don't need our own sync interval. The observable callbacks
    // above are invoked by the SDK at export time. We keep a timer
    // reference so dispose() can be a clean no-op.
    const intervalId = setInterval(() => {
      // Intentional no-op: observable callbacks handle sync.
      // This interval exists solely so dispose() has something to clear,
      // and to keep the bridge "alive" in the event loop.
    }, syncIntervalMs);

    return {
      dispose: () => {
        clearInterval(intervalId);
        logger.info("telemetry", "MetricsBridge disposed");
      },
    };
  } catch (err: unknown) {
    logger.error("telemetry", "Failed to create MetricsBridge", err);
    return NOOP_HANDLE;
  }
}
