/**
 * Prometheus metrics collection and exposition format output.
 *
 * Tracks core daemon metrics:
 *   - Counter: total events processed
 *   - Gauge: active sessions count
 *   - Gauge: event queue depth
 *   - Histogram: loop cycle time
 *   - Counter: total tokens used (by model)
 *   - Counter: total cost USD
 *
 * The `formatPrometheus()` function outputs standard Prometheus exposition format
 * (text/plain; version=0.0.4) suitable for scraping by Prometheus or compatible tools.
 */

// ---------------------------------------------------------------------------
// Metric types
// ---------------------------------------------------------------------------

export interface CounterMetric {
  readonly name: string;
  readonly help: string;
  readonly type: "counter";
  readonly labels?: readonly string[];
  values: Map<string, number>;
}

export interface GaugeMetric {
  readonly name: string;
  readonly help: string;
  readonly type: "gauge";
  values: Map<string, number>;
}

export interface HistogramMetric {
  readonly name: string;
  readonly help: string;
  readonly type: "histogram";
  readonly buckets: readonly number[];
  sum: number;
  count: number;
  bucketCounts: Map<number, number>;
}

// ---------------------------------------------------------------------------
// Default histogram buckets for loop cycle time (milliseconds)
// ---------------------------------------------------------------------------

const DEFAULT_LOOP_BUCKETS: readonly number[] = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// ---------------------------------------------------------------------------
// MetricsRegistry
// ---------------------------------------------------------------------------

export class MetricsRegistry {
  // Counters
  readonly eventsProcessed: CounterMetric = {
    name: "eidolon_events_processed_total",
    help: "Total number of events processed by the cognitive loop",
    type: "counter",
    values: new Map([["", 0]]),
  };

  readonly tokensUsed: CounterMetric = {
    name: "eidolon_tokens_used_total",
    help: "Total tokens used by model",
    type: "counter",
    labels: ["model"],
    values: new Map(),
  };

  readonly costUsd: CounterMetric = {
    name: "eidolon_cost_usd_total",
    help: "Total cost in USD",
    type: "counter",
    values: new Map([["", 0]]),
  };

  // Gauges
  readonly activeSessions: GaugeMetric = {
    name: "eidolon_active_sessions",
    help: "Number of currently active sessions",
    type: "gauge",
    values: new Map([["", 0]]),
  };

  readonly eventQueueDepth: GaugeMetric = {
    name: "eidolon_event_queue_depth",
    help: "Number of unprocessed events in the event queue",
    type: "gauge",
    values: new Map([["", 0]]),
  };

  // Histogram
  readonly loopCycleTime: HistogramMetric = {
    name: "eidolon_loop_cycle_duration_ms",
    help: "Duration of cognitive loop cycles in milliseconds",
    type: "histogram",
    buckets: DEFAULT_LOOP_BUCKETS,
    sum: 0,
    count: 0,
    bucketCounts: new Map(DEFAULT_LOOP_BUCKETS.map((b) => [b, 0])),
  };

  // -------------------------------------------------------------------------
  // Mutation methods
  // -------------------------------------------------------------------------

  /** Increment the total events processed counter. */
  incEventsProcessed(count = 1): void {
    const current = this.eventsProcessed.values.get("") ?? 0;
    this.eventsProcessed.values.set("", current + count);
  }

  /** Increment token usage counter for a specific model. */
  incTokensUsed(model: string, tokens: number): void {
    const current = this.tokensUsed.values.get(model) ?? 0;
    this.tokensUsed.values.set(model, current + tokens);
  }

  /** Increment total cost counter. */
  incCostUsd(amount: number): void {
    const current = this.costUsd.values.get("") ?? 0;
    this.costUsd.values.set("", current + amount);
  }

  /** Set the active sessions gauge. */
  setActiveSessions(count: number): void {
    this.activeSessions.values.set("", count);
  }

  /** Set the event queue depth gauge. */
  setEventQueueDepth(depth: number): void {
    this.eventQueueDepth.values.set("", depth);
  }

  /** Observe a loop cycle duration for the histogram. */
  observeLoopCycleTime(durationMs: number): void {
    this.loopCycleTime.sum += durationMs;
    this.loopCycleTime.count += 1;
    for (const bucket of this.loopCycleTime.buckets) {
      if (durationMs <= bucket) {
        const current = this.loopCycleTime.bucketCounts.get(bucket) ?? 0;
        this.loopCycleTime.bucketCounts.set(bucket, current + 1);
      }
    }
  }

  /** Reset all metrics to zero. Useful for testing. */
  reset(): void {
    this.eventsProcessed.values.set("", 0);
    this.tokensUsed.values.clear();
    this.costUsd.values.set("", 0);
    this.activeSessions.values.set("", 0);
    this.eventQueueDepth.values.set("", 0);
    this.loopCycleTime.sum = 0;
    this.loopCycleTime.count = 0;
    for (const bucket of this.loopCycleTime.buckets) {
      this.loopCycleTime.bucketCounts.set(bucket, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/** Format a counter metric into Prometheus exposition format lines. */
function formatCounter(metric: CounterMetric): string {
  const lines: string[] = [];
  lines.push(`# HELP ${metric.name} ${metric.help}`);
  lines.push(`# TYPE ${metric.name} counter`);

  for (const [label, value] of metric.values.entries()) {
    if (label === "") {
      lines.push(`${metric.name} ${value}`);
    } else {
      // Use the first label name from the metric definition
      const labelName = metric.labels?.[0] ?? "label";
      lines.push(`${metric.name}{${labelName}="${escapeLabel(label)}"} ${value}`);
    }
  }

  return lines.join("\n");
}

/** Format a gauge metric into Prometheus exposition format lines. */
function formatGauge(metric: GaugeMetric): string {
  const lines: string[] = [];
  lines.push(`# HELP ${metric.name} ${metric.help}`);
  lines.push(`# TYPE ${metric.name} gauge`);

  for (const [label, value] of metric.values.entries()) {
    if (label === "") {
      lines.push(`${metric.name} ${value}`);
    } else {
      lines.push(`${metric.name}{label="${escapeLabel(label)}"} ${value}`);
    }
  }

  return lines.join("\n");
}

/** Format a histogram metric into Prometheus exposition format lines. */
function formatHistogram(metric: HistogramMetric): string {
  const lines: string[] = [];
  lines.push(`# HELP ${metric.name} ${metric.help}`);
  lines.push(`# TYPE ${metric.name} histogram`);

  // Bucket counts are already stored cumulatively by observeLoopCycleTime
  // (each observation increments all buckets where value <= bucket boundary).
  // Output them directly per the Prometheus exposition format.
  for (const bucket of metric.buckets) {
    const count = metric.bucketCounts.get(bucket) ?? 0;
    lines.push(`${metric.name}_bucket{le="${bucket}"} ${count}`);
  }
  lines.push(`${metric.name}_bucket{le="+Inf"} ${metric.count}`);
  lines.push(`${metric.name}_sum ${metric.sum}`);
  lines.push(`${metric.name}_count ${metric.count}`);

  return lines.join("\n");
}

/** Escape special characters in label values per Prometheus spec. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * Format all metrics from a MetricsRegistry into Prometheus exposition format.
 * Returns a string suitable for responding to GET /metrics.
 */
export function formatPrometheus(registry: MetricsRegistry): string {
  const sections: string[] = [
    formatCounter(registry.eventsProcessed),
    formatCounter(registry.tokensUsed),
    formatCounter(registry.costUsd),
    formatGauge(registry.activeSessions),
    formatGauge(registry.eventQueueDepth),
    formatHistogram(registry.loopCycleTime),
  ];

  return sections.join("\n\n") + "\n";
}

/** The Content-Type header value for Prometheus exposition format. */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
