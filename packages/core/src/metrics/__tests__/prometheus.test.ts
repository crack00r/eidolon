import { describe, expect, test } from "bun:test";
import { formatPrometheus, MetricsRegistry, PROMETHEUS_CONTENT_TYPE } from "../prometheus.ts";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MetricsRegistry", () => {
  test("initial state has zeroed counters and gauges", () => {
    const registry = new MetricsRegistry();

    expect(registry.eventsProcessed.values.get("")).toBe(0);
    expect(registry.costUsd.values.get("")).toBe(0);
    expect(registry.activeSessions.values.get("")).toBe(0);
    expect(registry.eventQueueDepth.values.get("")).toBe(0);
    expect(registry.loopCycleTime.sum).toBe(0);
    expect(registry.loopCycleTime.count).toBe(0);
  });

  test("incEventsProcessed increments counter", () => {
    const registry = new MetricsRegistry();

    registry.incEventsProcessed();
    expect(registry.eventsProcessed.values.get("")).toBe(1);

    registry.incEventsProcessed(5);
    expect(registry.eventsProcessed.values.get("")).toBe(6);
  });

  test("incTokensUsed tracks per-model usage", () => {
    const registry = new MetricsRegistry();

    registry.incTokensUsed("claude-sonnet-4-20250514", 1000);
    registry.incTokensUsed("claude-haiku-3-20250414", 500);
    registry.incTokensUsed("claude-sonnet-4-20250514", 2000);

    expect(registry.tokensUsed.values.get("claude-sonnet-4-20250514")).toBe(3000);
    expect(registry.tokensUsed.values.get("claude-haiku-3-20250414")).toBe(500);
  });

  test("incCostUsd increments cost counter", () => {
    const registry = new MetricsRegistry();

    registry.incCostUsd(0.05);
    registry.incCostUsd(0.1);

    const cost = registry.costUsd.values.get("");
    expect(cost).toBeCloseTo(0.15, 10);
  });

  test("setActiveSessions sets gauge value", () => {
    const registry = new MetricsRegistry();

    registry.setActiveSessions(3);
    expect(registry.activeSessions.values.get("")).toBe(3);

    registry.setActiveSessions(1);
    expect(registry.activeSessions.values.get("")).toBe(1);
  });

  test("setEventQueueDepth sets gauge value", () => {
    const registry = new MetricsRegistry();

    registry.setEventQueueDepth(42);
    expect(registry.eventQueueDepth.values.get("")).toBe(42);
  });

  test("observeLoopCycleTime populates histogram buckets cumulatively", () => {
    const registry = new MetricsRegistry();

    // Observe values: 3ms, 15ms, 150ms
    registry.observeLoopCycleTime(3);
    registry.observeLoopCycleTime(15);
    registry.observeLoopCycleTime(150);

    expect(registry.loopCycleTime.count).toBe(3);
    expect(registry.loopCycleTime.sum).toBe(168);

    // 3ms <= bucket 5 -> count 1 in bucket 5
    expect(registry.loopCycleTime.bucketCounts.get(5)).toBe(1);
    // 15ms <= bucket 25 -> count 1 in bucket 25 (3ms also in 25, but that was counted separately)
    expect(registry.loopCycleTime.bucketCounts.get(25)).toBe(2);
    // 150ms <= bucket 250 -> count 1 in bucket 250
    expect(registry.loopCycleTime.bucketCounts.get(250)).toBe(3);
    // Bucket 1 should have 0 (3ms > 1)
    expect(registry.loopCycleTime.bucketCounts.get(1)).toBe(0);
  });

  test("reset() zeroes all metrics", () => {
    const registry = new MetricsRegistry();

    registry.incEventsProcessed(10);
    registry.incTokensUsed("sonnet", 5000);
    registry.incCostUsd(1.5);
    registry.setActiveSessions(3);
    registry.setEventQueueDepth(20);
    registry.observeLoopCycleTime(100);

    registry.reset();

    expect(registry.eventsProcessed.values.get("")).toBe(0);
    expect(registry.tokensUsed.values.size).toBe(0);
    expect(registry.costUsd.values.get("")).toBe(0);
    expect(registry.activeSessions.values.get("")).toBe(0);
    expect(registry.eventQueueDepth.values.get("")).toBe(0);
    expect(registry.loopCycleTime.sum).toBe(0);
    expect(registry.loopCycleTime.count).toBe(0);
    for (const count of registry.loopCycleTime.bucketCounts.values()) {
      expect(count).toBe(0);
    }
  });
});

describe("formatPrometheus", () => {
  test("formats empty registry with correct structure", () => {
    const registry = new MetricsRegistry();
    const output = formatPrometheus(registry);

    // Should contain HELP and TYPE lines for all metrics
    expect(output).toContain("# HELP eidolon_events_processed_total");
    expect(output).toContain("# TYPE eidolon_events_processed_total counter");
    expect(output).toContain("# HELP eidolon_tokens_used_total");
    expect(output).toContain("# TYPE eidolon_tokens_used_total counter");
    expect(output).toContain("# HELP eidolon_cost_usd_total");
    expect(output).toContain("# TYPE eidolon_cost_usd_total counter");
    expect(output).toContain("# HELP eidolon_active_sessions");
    expect(output).toContain("# TYPE eidolon_active_sessions gauge");
    expect(output).toContain("# HELP eidolon_event_queue_depth");
    expect(output).toContain("# TYPE eidolon_event_queue_depth gauge");
    expect(output).toContain("# HELP eidolon_loop_cycle_duration_ms");
    expect(output).toContain("# TYPE eidolon_loop_cycle_duration_ms histogram");
    expect(output).toContain('eidolon_loop_cycle_duration_ms_bucket{le="+Inf"} 0');
    expect(output).toContain("eidolon_loop_cycle_duration_ms_sum 0");
    expect(output).toContain("eidolon_loop_cycle_duration_ms_count 0");
  });

  test("formats counter with label", () => {
    const registry = new MetricsRegistry();
    registry.incTokensUsed("claude-sonnet-4-20250514", 1500);
    registry.incTokensUsed("claude-haiku-3-20250414", 500);

    const output = formatPrometheus(registry);

    expect(output).toContain('eidolon_tokens_used_total{model="claude-sonnet-4-20250514"} 1500');
    expect(output).toContain('eidolon_tokens_used_total{model="claude-haiku-3-20250414"} 500');
  });

  test("formats gauge values", () => {
    const registry = new MetricsRegistry();
    registry.setActiveSessions(3);
    registry.setEventQueueDepth(12);

    const output = formatPrometheus(registry);

    expect(output).toContain("eidolon_active_sessions 3");
    expect(output).toContain("eidolon_event_queue_depth 12");
  });

  test("formats histogram with cumulative buckets", () => {
    const registry = new MetricsRegistry();
    // Observe: 3ms goes into all buckets >= 5
    // Observe: 15ms goes into all buckets >= 25
    registry.observeLoopCycleTime(3);
    registry.observeLoopCycleTime(15);

    const output = formatPrometheus(registry);

    // Bucket 1: 0 (3 > 1)
    expect(output).toContain('eidolon_loop_cycle_duration_ms_bucket{le="1"} 0');
    // Bucket 5: 1 (3 <= 5)
    expect(output).toContain('eidolon_loop_cycle_duration_ms_bucket{le="5"} 1');
    // Bucket 10: 1 (3 <= 10, but 15 > 10)
    expect(output).toContain('eidolon_loop_cycle_duration_ms_bucket{le="10"} 1');
    // Bucket 25: 2 (3 <= 25, 15 <= 25)
    expect(output).toContain('eidolon_loop_cycle_duration_ms_bucket{le="25"} 2');
    // +Inf always equals total count
    expect(output).toContain('eidolon_loop_cycle_duration_ms_bucket{le="+Inf"} 2');
    expect(output).toContain("eidolon_loop_cycle_duration_ms_sum 18");
    expect(output).toContain("eidolon_loop_cycle_duration_ms_count 2");
  });

  test("escapes label values per Prometheus spec", () => {
    const registry = new MetricsRegistry();
    // Model name with special characters
    registry.incTokensUsed('model-with"quotes', 100);
    registry.incTokensUsed("model-with\\backslash", 200);

    const output = formatPrometheus(registry);

    expect(output).toContain('model-with\\"quotes');
    expect(output).toContain("model-with\\\\backslash");
  });

  test("output ends with newline", () => {
    const registry = new MetricsRegistry();
    const output = formatPrometheus(registry);
    expect(output.endsWith("\n")).toBe(true);
  });
});

describe("PROMETHEUS_CONTENT_TYPE", () => {
  test("matches the Prometheus exposition format content type", () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
