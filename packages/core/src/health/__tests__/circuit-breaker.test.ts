import { describe, expect, test } from "bun:test";
import type { CircuitBreakerConfig } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.js";
import { CircuitBreaker } from "../circuit-breaker.js";

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
    name: "test-circuit",
    failureThreshold: 3,
    resetTimeoutMs: 100,
    halfOpenMaxAttempts: 1,
    ...overrides,
  };
}

describe("CircuitBreaker", () => {
  const logger = createSilentLogger();

  test("closed state passes requests through", async () => {
    const cb = new CircuitBreaker(makeConfig(), logger);

    const result = await cb.execute(async () => "hello");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello");

    expect(cb.getStatus().state).toBe("closed");
  });

  test("opens after failure threshold reached", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 2 }), logger);

    const fail = (): Promise<never> => Promise.reject(new Error("boom"));

    await cb.execute(fail);
    expect(cb.getStatus().state).toBe("closed");

    await cb.execute(fail);
    expect(cb.getStatus().state).toBe("open");
    expect(cb.getStatus().failures).toBe(2);
  });

  test("returns CIRCUIT_OPEN error when open", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: 60_000 }), logger);

    await cb.execute(() => Promise.reject(new Error("fail")));
    expect(cb.getStatus().state).toBe("open");

    const result = await cb.execute(async () => "should not run");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CIRCUIT_OPEN");
  });

  test("transitions to half-open after timeout", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: 50 }), logger);

    await cb.execute(() => Promise.reject(new Error("fail")));
    expect(cb.getStatus().state).toBe("open");

    // Wait for reset timeout
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Next call should transition to half_open and succeed
    const result = await cb.execute(async () => "recovered");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("recovered");
    expect(cb.getStatus().state).toBe("closed");
  });

  test("closes on successful probe in half-open", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: 50 }), logger);

    await cb.execute(() => Promise.reject(new Error("fail")));
    expect(cb.getStatus().state).toBe("open");

    await new Promise((resolve) => setTimeout(resolve, 60));

    const result = await cb.execute(async () => 42);
    expect(result.ok).toBe(true);
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(0);
  });

  test("returns to open on failed probe in half-open", async () => {
    const cb = new CircuitBreaker(makeConfig({ failureThreshold: 1, resetTimeoutMs: 50 }), logger);

    await cb.execute(() => Promise.reject(new Error("fail1")));
    expect(cb.getStatus().state).toBe("open");

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Probe fails
    await cb.execute(() => Promise.reject(new Error("fail2")));
    expect(cb.getStatus().state).toBe("open");
  });

  test("reset() restores closed state", () => {
    const cb = new CircuitBreaker(makeConfig(), logger);
    cb.reset();
    expect(cb.getStatus().state).toBe("closed");
    expect(cb.getStatus().failures).toBe(0);
  });
});
