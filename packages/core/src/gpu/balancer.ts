/**
 * Load balancer strategies for distributing GPU requests across workers.
 *
 * Three strategies are provided:
 * - RoundRobinBalancer: simple rotation through workers
 * - LeastConnectionsBalancer: route to worker with fewest active requests
 * - LatencyWeightedBalancer: prefer workers with lowest average latency
 */

import type { GPUWorkerInfo } from "./worker.ts";

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

/** Selects the best worker from a list of candidates for a given capability. */
export interface LoadBalancerStrategy {
  /** Select a worker that supports the given capability, or null if none available. */
  select(workers: readonly GPUWorkerInfo[], capability: string): GPUWorkerInfo | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Filter workers to those that are in a usable circuit state ("closed" or "half_open")
 * and support the requested capability.
 */
function filterAvailable(workers: readonly GPUWorkerInfo[], capability: string): readonly GPUWorkerInfo[] {
  return workers.filter(
    (w) =>
      (w.circuitState === "closed" || w.circuitState === "half_open") &&
      w.capabilities.includes(capability as "tts" | "stt" | "realtime"),
  );
}

// ---------------------------------------------------------------------------
// RoundRobinBalancer
// ---------------------------------------------------------------------------

/** Cycles through available workers in round-robin order. */
export class RoundRobinBalancer implements LoadBalancerStrategy {
  private index = 0;

  select(workers: readonly GPUWorkerInfo[], capability: string): GPUWorkerInfo | null {
    const available = filterAvailable(workers, capability);
    if (available.length === 0) return null;

    const selected = available[this.index % available.length];
    this.index = (this.index + 1) % available.length;
    return selected ?? null;
  }
}

// ---------------------------------------------------------------------------
// LeastConnectionsBalancer
// ---------------------------------------------------------------------------

/** Routes requests to the worker with the fewest active requests. */
export class LeastConnectionsBalancer implements LoadBalancerStrategy {
  select(workers: readonly GPUWorkerInfo[], capability: string): GPUWorkerInfo | null {
    const available = filterAvailable(workers, capability);
    if (available.length === 0) return null;

    let best: GPUWorkerInfo | null = null;
    let bestCount = Number.MAX_SAFE_INTEGER;

    for (const worker of available) {
      if (worker.activeRequests < bestCount) {
        bestCount = worker.activeRequests;
        best = worker;
      }
    }

    return best;
  }
}

// ---------------------------------------------------------------------------
// LatencyWeightedBalancer
// ---------------------------------------------------------------------------

/**
 * Routes requests to the worker with the lowest average latency.
 * Workers with zero latency (no measurements yet) are given a neutral score
 * so they can be tried.
 */
export class LatencyWeightedBalancer implements LoadBalancerStrategy {
  select(workers: readonly GPUWorkerInfo[], capability: string): GPUWorkerInfo | null {
    const available = filterAvailable(workers, capability);
    if (available.length === 0) return null;

    let best: GPUWorkerInfo | null = null;
    let bestScore = Number.MAX_SAFE_INTEGER;

    for (const worker of available) {
      // Workers with no latency data get a neutral middle-ground score
      // so they are not permanently ignored or always preferred.
      const latency = worker.avgLatencyMs > 0 ? worker.avgLatencyMs : 500;

      // Combined score: latency + penalty for active requests
      // This prevents routing all traffic to the fastest worker while it is overloaded.
      const score = latency + worker.activeRequests * 100;

      if (score < bestScore) {
        bestScore = score;
        best = worker;
      }
    }

    return best;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type BalancingStrategyName = "round-robin" | "least-connections" | "latency-weighted";

/** Create a balancer strategy from its name. */
export function createBalancer(strategy: BalancingStrategyName): LoadBalancerStrategy {
  switch (strategy) {
    case "round-robin":
      return new RoundRobinBalancer();
    case "least-connections":
      return new LeastConnectionsBalancer();
    case "latency-weighted":
      return new LatencyWeightedBalancer();
  }
}
