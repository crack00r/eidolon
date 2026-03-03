/**
 * Health store -- tracks system health, circuit breakers,
 * GPU worker status, and token usage metrics.
 * Auto-refreshes every 30 seconds.
 */

import { derived, writable } from "svelte/store";
import { clientLog } from "$lib/logger";
import { sanitizeErrorForDisplay } from "$lib/utils";
import { getClient } from "./connection";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerInfo {
  name: string;
  state: CircuitState;
  failures: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
}

export interface GpuWorkerInfo {
  name: string;
  host: string;
  status: "online" | "offline" | "degraded";
  capabilities: string[];
  gpuUtil?: number;
  vramUsed?: number;
  vramTotal?: number;
  temperature?: number;
}

export interface TokenUsagePoint {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface HealthData {
  status: "healthy" | "degraded" | "unhealthy";
  checks: Array<{ name: string; status: "pass" | "fail" | "warn"; message?: string }>;
  circuitBreakers: CircuitBreakerInfo[];
  gpuWorkers: GpuWorkerInfo[];
  tokenUsage: TokenUsagePoint[];
  eventQueueDepth: number;
  memoryStats: { totalMemories: number; recentExtractions: number };
  errorRate: number;
  uptimeMs: number;
}

const DEFAULT_HEALTH: HealthData = {
  status: "healthy",
  checks: [],
  circuitBreakers: [],
  gpuWorkers: [],
  tokenUsage: [],
  eventQueueDepth: 0,
  memoryStats: { totalMemories: 0, recentExtractions: 0 },
  errorRate: 0,
  uptimeMs: 0,
};

const REFRESH_INTERVAL_MS = 30_000;

const healthStore = writable<HealthData>({ ...DEFAULT_HEALTH });
const loadingStore = writable(false);
const errorStore = writable<string | null>(null);

let refreshTimer: ReturnType<typeof setInterval> | null = null;

function parseHealthData(raw: Record<string, unknown>): HealthData {
  return {
    status: (raw.status as HealthData["status"]) ?? "healthy",
    checks: Array.isArray(raw.checks)
      ? (raw.checks as HealthData["checks"])
      : [],
    circuitBreakers: Array.isArray(raw.circuitBreakers)
      ? (raw.circuitBreakers as CircuitBreakerInfo[])
      : [],
    gpuWorkers: Array.isArray(raw.gpuWorkers)
      ? (raw.gpuWorkers as GpuWorkerInfo[])
      : [],
    tokenUsage: Array.isArray(raw.tokenUsage)
      ? (raw.tokenUsage as TokenUsagePoint[])
      : [],
    eventQueueDepth: typeof raw.eventQueueDepth === "number" ? raw.eventQueueDepth : 0,
    memoryStats: typeof raw.memoryStats === "object" && raw.memoryStats !== null
      ? (raw.memoryStats as HealthData["memoryStats"])
      : { totalMemories: 0, recentExtractions: 0 },
    errorRate: typeof raw.errorRate === "number" ? raw.errorRate : 0,
    uptimeMs: typeof raw.uptimeMs === "number" ? raw.uptimeMs : 0,
  };
}

export async function fetchHealth(): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  loadingStore.set(true);
  errorStore.set(null);

  try {
    const result = await client.call<Record<string, unknown>>("system.health");
    healthStore.set(parseHealthData(result));
  } catch (err) {
    clientLog("error", "health", "fetchHealth failed", err);
    const msg = sanitizeErrorForDisplay(err, "Failed to fetch health data");
    errorStore.set(msg);
  } finally {
    loadingStore.set(false);
  }
}

export function startHealthRefresh(): void {
  stopHealthRefresh();
  fetchHealth();
  refreshTimer = setInterval(() => {
    fetchHealth();
  }, REFRESH_INTERVAL_MS);
}

export function stopHealthRefresh(): void {
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

export const healthData = { subscribe: healthStore.subscribe };
export const isLoadingHealth = { subscribe: loadingStore.subscribe };
export const healthError = { subscribe: errorStore.subscribe };

export const overallStatus = derived(healthStore, (h) => h.status);
export const circuitBreakers = derived(healthStore, (h) => h.circuitBreakers);
export const gpuWorkers = derived(healthStore, (h) => h.gpuWorkers);
export const tokenUsage = derived(healthStore, (h) => h.tokenUsage);
export const eventQueueDepth = derived(healthStore, (h) => h.eventQueueDepth);
export const memoryStats = derived(healthStore, (h) => h.memoryStats);
export const errorRate = derived(healthStore, (h) => h.errorRate);
