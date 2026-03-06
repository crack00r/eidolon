import { describe, expect, test } from "bun:test";
import { createBalancer, LatencyWeightedBalancer, LeastConnectionsBalancer, RoundRobinBalancer } from "../balancer.ts";
import type { GPUWorkerInfo } from "../worker.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorker(overrides: Partial<GPUWorkerInfo> & { name: string }): GPUWorkerInfo {
  return {
    url: `http://${overrides.name}:8420`,
    capabilities: ["tts", "stt"],
    health: null,
    circuitState: "closed",
    activeRequests: 0,
    avgLatencyMs: 0,
    lastHealthCheck: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RoundRobinBalancer
// ---------------------------------------------------------------------------

describe("RoundRobinBalancer", () => {
  test("rotates through available workers", () => {
    const balancer = new RoundRobinBalancer();
    const workers = [
      makeWorker({ name: "worker-1" }),
      makeWorker({ name: "worker-2" }),
      makeWorker({ name: "worker-3" }),
    ];

    const first = balancer.select(workers, "tts");
    const second = balancer.select(workers, "tts");
    const third = balancer.select(workers, "tts");
    const fourth = balancer.select(workers, "tts");

    expect(first?.name).toBe("worker-1");
    expect(second?.name).toBe("worker-2");
    expect(third?.name).toBe("worker-3");
    // Wraps around
    expect(fourth?.name).toBe("worker-1");
  });

  test("returns null for empty worker list", () => {
    const balancer = new RoundRobinBalancer();
    const result = balancer.select([], "tts");
    expect(result).toBeNull();
  });

  test("skips workers with open circuit", () => {
    const balancer = new RoundRobinBalancer();
    const workers = [
      makeWorker({ name: "worker-1", circuitState: "open" }),
      makeWorker({ name: "worker-2", circuitState: "closed" }),
    ];

    const result = balancer.select(workers, "tts");
    expect(result?.name).toBe("worker-2");
  });

  test("skips workers without required capability", () => {
    const balancer = new RoundRobinBalancer();
    const workers = [
      makeWorker({ name: "tts-only", capabilities: ["tts"] }),
      makeWorker({ name: "stt-only", capabilities: ["stt"] }),
    ];

    const result = balancer.select(workers, "stt");
    expect(result?.name).toBe("stt-only");
  });

  test("allows half_open workers", () => {
    const balancer = new RoundRobinBalancer();
    const workers = [makeWorker({ name: "worker-1", circuitState: "half_open" })];

    const result = balancer.select(workers, "tts");
    expect(result?.name).toBe("worker-1");
  });

  test("returns null when no workers support capability", () => {
    const balancer = new RoundRobinBalancer();
    const workers = [makeWorker({ name: "tts-only", capabilities: ["tts"] })];

    const result = balancer.select(workers, "stt");
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LeastConnectionsBalancer
// ---------------------------------------------------------------------------

describe("LeastConnectionsBalancer", () => {
  test("selects worker with fewest active requests", () => {
    const balancer = new LeastConnectionsBalancer();
    const workers = [
      makeWorker({ name: "busy", activeRequests: 5 }),
      makeWorker({ name: "idle", activeRequests: 0 }),
      makeWorker({ name: "moderate", activeRequests: 2 }),
    ];

    const result = balancer.select(workers, "tts");
    expect(result?.name).toBe("idle");
  });

  test("returns null for empty worker list", () => {
    const balancer = new LeastConnectionsBalancer();
    const result = balancer.select([], "tts");
    expect(result).toBeNull();
  });

  test("skips workers with open circuit", () => {
    const balancer = new LeastConnectionsBalancer();
    const workers = [
      makeWorker({ name: "idle-but-open", activeRequests: 0, circuitState: "open" }),
      makeWorker({ name: "busy-but-closed", activeRequests: 3, circuitState: "closed" }),
    ];

    const result = balancer.select(workers, "tts");
    expect(result?.name).toBe("busy-but-closed");
  });

  test("handles tie by returning first found", () => {
    const balancer = new LeastConnectionsBalancer();
    const workers = [
      makeWorker({ name: "worker-1", activeRequests: 1 }),
      makeWorker({ name: "worker-2", activeRequests: 1 }),
    ];

    const result = balancer.select(workers, "tts");
    // Should pick the first one with the fewest
    expect(result?.name).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LatencyWeightedBalancer
// ---------------------------------------------------------------------------

describe("LatencyWeightedBalancer", () => {
  test("selects worker with lowest latency", () => {
    const balancer = new LatencyWeightedBalancer();
    const workers = [
      makeWorker({ name: "slow", avgLatencyMs: 500 }),
      makeWorker({ name: "fast", avgLatencyMs: 50 }),
      makeWorker({ name: "medium", avgLatencyMs: 200 }),
    ];

    const result = balancer.select(workers, "tts");
    expect(result?.name).toBe("fast");
  });

  test("handles workers with no latency data using neutral score", () => {
    const balancer = new LatencyWeightedBalancer();
    const workers = [
      makeWorker({ name: "no-data", avgLatencyMs: 0 }),
      makeWorker({ name: "known-fast", avgLatencyMs: 100 }),
    ];

    // no-data gets 500 neutral score, known-fast gets 100 score
    // known-fast should win
    const result = balancer.select(workers, "tts");
    expect(result?.name).toBe("known-fast");
  });

  test("penalizes high active requests even with low latency", () => {
    const balancer = new LatencyWeightedBalancer();
    const workers = [
      makeWorker({ name: "fast-busy", avgLatencyMs: 50, activeRequests: 10 }),
      makeWorker({ name: "slow-idle", avgLatencyMs: 200, activeRequests: 0 }),
    ];

    // fast-busy: 50 + 10*100 = 1050
    // slow-idle: 200 + 0*100 = 200
    const result = balancer.select(workers, "tts");
    expect(result?.name).toBe("slow-idle");
  });

  test("returns null for empty worker list", () => {
    const balancer = new LatencyWeightedBalancer();
    const result = balancer.select([], "tts");
    expect(result).toBeNull();
  });

  test("zero-latency worker preferred over very slow worker", () => {
    const balancer = new LatencyWeightedBalancer();
    const workers = [
      makeWorker({ name: "very-slow", avgLatencyMs: 2000 }),
      makeWorker({ name: "unknown", avgLatencyMs: 0 }),
    ];

    // very-slow: score = 2000, unknown: score = 500 (neutral)
    const result = balancer.select(workers, "tts");
    expect(result?.name).toBe("unknown");
  });

  test("skips workers with open circuit", () => {
    const balancer = new LatencyWeightedBalancer();
    const workers = [
      makeWorker({ name: "fastest-open", avgLatencyMs: 10, circuitState: "open" }),
      makeWorker({ name: "slower-closed", avgLatencyMs: 300, circuitState: "closed" }),
    ];

    const result = balancer.select(workers, "tts");
    expect(result?.name).toBe("slower-closed");
  });
});

// ---------------------------------------------------------------------------
// createBalancer factory
// ---------------------------------------------------------------------------

describe("createBalancer", () => {
  test("creates round-robin balancer", () => {
    const balancer = createBalancer("round-robin");
    expect(balancer).toBeInstanceOf(RoundRobinBalancer);
  });

  test("creates least-connections balancer", () => {
    const balancer = createBalancer("least-connections");
    expect(balancer).toBeInstanceOf(LeastConnectionsBalancer);
  });

  test("creates latency-weighted balancer", () => {
    const balancer = createBalancer("latency-weighted");
    expect(balancer).toBeInstanceOf(LatencyWeightedBalancer);
  });
});
