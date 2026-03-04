import { describe, expect, test } from "bun:test";
import { createLogger } from "../../logging/logger.ts";
import { initTelemetry } from "../provider.ts";
import { NoopTracer } from "../tracer.ts";

const logger = createLogger({ level: "error", format: "json", directory: "", maxSizeMb: 50, maxFiles: 10 });

describe("initTelemetry", () => {
  test("returns NoopTracer when disabled", async () => {
    const provider = await initTelemetry(
      {
        enabled: false,
        endpoint: "http://localhost:4318",
        protocol: "http",
        serviceName: "test",
        sampleRate: 1.0,
        exportIntervalMs: 5000,
        attributes: {},
      },
      logger,
    );

    expect(provider.enabled).toBe(false);
    expect(provider.tracer).toBeInstanceOf(NoopTracer);

    // shutdown should be a no-op
    await provider.shutdown();
  });

  test("returns enabled provider when telemetry is enabled", async () => {
    // This test initializes a real OTel SDK. The OTLP endpoint will not
    // be reachable, but the provider should still start successfully
    // (exports will fail silently in the background).
    const provider = await initTelemetry(
      {
        enabled: true,
        endpoint: "http://localhost:19999", // non-existent on purpose
        protocol: "http",
        serviceName: "test-service",
        sampleRate: 1.0,
        exportIntervalMs: 60000, // long interval to avoid background noise
        attributes: { "test.key": "test.value" },
      },
      logger,
    );

    expect(provider.enabled).toBe(true);
    expect(provider.tracer).not.toBeInstanceOf(NoopTracer);

    // Clean up
    await provider.shutdown();
  });

  test("withSpan on real provider executes the function", async () => {
    const provider = await initTelemetry(
      {
        enabled: true,
        endpoint: "http://localhost:19999",
        protocol: "http",
        serviceName: "test-service",
        sampleRate: 1.0,
        exportIntervalMs: 60000,
        attributes: {},
      },
      logger,
    );

    const result = await provider.tracer.withSpan(
      "test-span",
      { "test.attr": "value" },
      async () => {
        return 123;
      },
    );

    expect(result).toBe(123);

    await provider.shutdown();
  });
});
