import { describe, expect, test } from "bun:test";
import { createLogger } from "../../logging/logger.ts";
import { MetricsRegistry } from "../../metrics/prometheus.ts";
import { createMetricsBridge } from "../metrics-bridge.ts";

const logger = createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 });

describe("createMetricsBridge", () => {
  test("returns no-op handle when disabled", async () => {
    const registry = new MetricsRegistry();
    const handle = await createMetricsBridge(registry, false, logger);

    // dispose should be a no-op
    handle.dispose();
  });

  test("returns active handle when enabled", async () => {
    const registry = new MetricsRegistry();

    // Populate some metrics
    registry.incEventsProcessed(10);
    registry.setActiveSessions(3);
    registry.setEventQueueDepth(7);
    registry.incTokensUsed("claude-sonnet-4-20250514", 5000);
    registry.incCostUsd(0.15);

    const handle = await createMetricsBridge(registry, true, logger);

    // The handle should be valid
    expect(handle).toBeDefined();

    // Clean up
    handle.dispose();
  });

  test("dispose cleans up the interval", async () => {
    const registry = new MetricsRegistry();
    const handle = await createMetricsBridge(registry, true, logger, 100);

    // Double dispose should not throw
    handle.dispose();
    handle.dispose();
  });
});
