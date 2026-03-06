import { describe, expect, test } from "bun:test";
import type { CircuitBreakerConfig } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import { CircuitBreaker } from "../circuit-breaker.ts";

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function makeConfig(overrides?: Partial<CircuitBreakerConfig>): CircuitBreakerConfig {
  return {
    name: "test-failures",
    failureThreshold: 3,
    resetTimeoutMs: 80,
    halfOpenMaxAttempts: 1,
    ...overrides,
  };
}

describe("CircuitBreaker failure scenarios", () => {
  const logger = createSilentLogger();

  test("stays closed below failure threshold", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 3 }), logger);

    // Two failures -- still below threshold
    await cb.execute(() => Promise.reject(new Error("fail-1")));
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(1);

    await cb.execute(() => Promise.reject(new Error("fail-2")));
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(2);
  });

  test("opens exactly at failure threshold", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 3 }), logger);

    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error(`fail-${i}`)));
    }

    expect(cb.getStatus().state).toBe("open");
    expect(cb.getStatus().failures).toBe(3);
  });

  test("open circuit rejects without calling the function", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: 60_000 }), logger);

    // Trip the circuit
    await cb.execute(() => Promise.reject(new Error("trip")));
    expect(cb.getStatus().state).toBe("open");

    // Subsequent calls should be rejected without invoking fn
    let fnCalled = false;
    const result = await cb.execute(async () => {
      fnCalled = true;
      return "should not run";
    });

    expect(fnCalled).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CIRCUIT_OPEN");
    }
  });

  test("transitions open -> half_open after resetTimeoutMs", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: 50 }), logger);

    await cb.execute(() => Promise.reject(new Error("trip")));
    expect(cb.getStatus().state).toBe("open");

    // Wait for reset timeout to elapse
    await new Promise((resolve) => setTimeout(resolve, 70));

    // The next execute() should probe (half-open), and if successful, close
    const result = await cb.execute(async () => "recovered");
    expect(result.ok).toBe(true);
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(0);
  });

  test("failed probe in half-open returns to open", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: 50 }), logger);

    // Trip the circuit
    await cb.execute(() => Promise.reject(new Error("trip")));
    expect(cb.getStatus().state).toBe("open");

    // Wait for reset timeout
    await new Promise((resolve) => setTimeout(resolve, 70));

    // Probe fails
    await cb.execute(() => Promise.reject(new Error("probe-fail")));
    expect(cb.getStatus().state).toBe("open");
  });

  test("successful probe after repeated failures closes the circuit", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 2, resetTimeoutMs: 50 }), logger);

    // Two failures to open
    await cb.execute(() => Promise.reject(new Error("f1")));
    await cb.execute(() => Promise.reject(new Error("f2")));
    expect(cb.getStatus().state).toBe("open");

    // Wait for reset
    await new Promise((resolve) => setTimeout(resolve, 70));

    // Successful probe
    const result = await cb.execute(async () => "back");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("back");
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(0);
  });

  test("interspersed successes reset failure count in closed state", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 3 }), logger);

    // Two failures
    await cb.execute(() => Promise.reject(new Error("f1")));
    await cb.execute(() => Promise.reject(new Error("f2")));
    expect(cb.getStatus().failures).toBe(2);

    // A success should reset the failure counter
    await cb.execute(async () => "ok");
    expect(cb.getStatus().failures).toBe(0);
    expect(cb.getStatus().state).toBe("closed");

    // Now two more failures should not open (counter was reset)
    await cb.execute(() => Promise.reject(new Error("f3")));
    await cb.execute(() => Promise.reject(new Error("f4")));
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(2);
  });

  test("multiple open-close cycles work correctly", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: 40 }), logger);

    // Cycle 1: trip, wait, recover
    await cb.execute(() => Promise.reject(new Error("trip-1")));
    expect(cb.getStatus().state).toBe("open");

    await new Promise((resolve) => setTimeout(resolve, 60));
    await cb.execute(async () => "ok-1");
    expect(cb.getStatus().state).toBe("closed");

    // Cycle 2: trip again, wait, recover again
    await cb.execute(() => Promise.reject(new Error("trip-2")));
    expect(cb.getStatus().state).toBe("open");

    await new Promise((resolve) => setTimeout(resolve, 60));
    await cb.execute(async () => "ok-2");
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(0);
  });

  test("reset() from open state returns to closed with zero failures", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1 }), logger);

    await cb.execute(() => Promise.reject(new Error("trip")));
    expect(cb.getStatus().state).toBe("open");
    expect(cb.getStatus().failures).toBe(1);

    cb.reset();

    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(0);

    // Should work normally after reset
    const result = await cb.execute(async () => "after-reset");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("after-reset");
  });

  test("getStatus reports lastFailureAt after failure", async () => {
    const cb = new CircuitBreaker(makeConfig(), logger);

    const before = Date.now();
    await cb.execute(() => Promise.reject(new Error("fail")));
    const after = Date.now();

    const status = cb.getStatus();
    expect(status.lastFailureAt).toBeDefined();
    expect(status.lastFailureAt).toBeGreaterThanOrEqual(before);
    expect(status.lastFailureAt).toBeLessThanOrEqual(after);
  });
});
