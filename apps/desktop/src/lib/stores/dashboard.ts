/**
 * Dashboard store — tracks real-time brain status by polling
 * system.status and subscribing to push notifications.
 */

import { derived, writable } from "svelte/store";
import { clientLog } from "../logger";
import { getClient } from "./connection";

export type CognitiveState =
  | "idle"
  | "perceiving"
  | "evaluating"
  | "acting"
  | "reflecting"
  | "dreaming";

export interface DashboardEvent {
  id: string;
  timestamp: number;
  type: "info" | "warning" | "error" | "state_change" | "task" | "memory" | "learning";
  description: string;
}

export interface SystemStatus {
  cognitiveState: CognitiveState;
  energy: { current: number; max: number };
  activeTasks: number;
  memoryCount: number;
  uptimeMs: number;
  connectedClients: Array<{ id: string; platform: string }>;
  serverVersion: string;
  connectedSince: number;
  latencyMs: number;
}

export interface DashboardState {
  status: SystemStatus;
  events: DashboardEvent[];
  lastUpdated: number;
  loading: boolean;
  error: string | null;
}

const DEFAULT_STATUS: SystemStatus = {
  cognitiveState: "idle",
  energy: { current: 0, max: 100 },
  activeTasks: 0,
  memoryCount: 0,
  uptimeMs: 0,
  connectedClients: [],
  serverVersion: "unknown",
  connectedSince: 0,
  latencyMs: 0,
};

const DEFAULT_STATE: DashboardState = {
  status: DEFAULT_STATUS,
  events: [],
  lastUpdated: 0,
  loading: false,
  error: null,
};

const MAX_EVENTS = 20;
const POLL_INTERVAL_MS = 5_000;

const store = writable<DashboardState>({ ...DEFAULT_STATE });

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let unsubscribePush: (() => void) | null = null;
let eventCounter = 0;

function nextEventId(): string {
  return `evt-${Date.now()}-${++eventCounter}`;
}

function addEvent(
  type: DashboardEvent["type"],
  description: string,
): void {
  store.update((s) => {
    const event: DashboardEvent = {
      id: nextEventId(),
      timestamp: Date.now(),
      type,
      description,
    };
    const events = [event, ...s.events].slice(0, MAX_EVENTS);
    return { ...s, events };
  });
}

function parseStatus(raw: Record<string, unknown>): SystemStatus {
  const energy = raw.energy as { current?: number; max?: number } | undefined;
  const clients = raw.connectedClients as Array<{ id?: string; platform?: string }> | undefined;

  return {
    cognitiveState: (raw.cognitiveState as CognitiveState) ?? "idle",
    energy: {
      current: typeof energy?.current === "number" ? energy.current : 0,
      max: typeof energy?.max === "number" ? energy.max : 100,
    },
    activeTasks: typeof raw.activeTasks === "number" ? raw.activeTasks : 0,
    memoryCount: typeof raw.memoryCount === "number" ? raw.memoryCount : 0,
    uptimeMs: typeof raw.uptimeMs === "number" ? raw.uptimeMs : 0,
    connectedClients: Array.isArray(clients)
      ? clients.map((c) => ({
          id: typeof c.id === "string" ? c.id : "unknown",
          platform: typeof c.platform === "string" ? c.platform : "unknown",
        }))
      : [],
    serverVersion: typeof raw.serverVersion === "string" ? raw.serverVersion : "unknown",
    connectedSince: typeof raw.connectedSince === "number" ? raw.connectedSince : 0,
    latencyMs: typeof raw.latencyMs === "number" ? raw.latencyMs : 0,
  };
}

async function fetchStatus(): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") return;

  const start = performance.now();
  try {
    const result = await client.call<Record<string, unknown>>("system.status");
    const latencyMs = Math.round(performance.now() - start);
    const status = parseStatus({ ...result, latencyMs });

    store.update((s) => {
      // Detect state changes and add events
      if (s.status.cognitiveState !== status.cognitiveState) {
        addEvent("state_change", `State changed: ${s.status.cognitiveState} → ${status.cognitiveState}`);
      }
      return {
        ...s,
        status,
        lastUpdated: Date.now(),
        loading: false,
        error: null,
      };
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch status";
    store.update((s) => ({
      ...s,
      loading: false,
      error: message,
    }));
    clientLog("warn", "dashboard", "Failed to fetch system status", err);
  }
}

function handlePush(method: string, params: Record<string, unknown>): void {
  if (method !== "system.statusUpdate") return;

  const status = parseStatus(params);
  store.update((s) => {
    if (s.status.cognitiveState !== status.cognitiveState) {
      addEvent("state_change", `State changed: ${s.status.cognitiveState} → ${status.cognitiveState}`);
    }
    return {
      ...s,
      status,
      lastUpdated: Date.now(),
      error: null,
    };
  });

  // Add any events the server sent along
  if (Array.isArray(params.recentEvents)) {
    for (const evt of params.recentEvents as Array<Record<string, unknown>>) {
      if (typeof evt.type === "string" && typeof evt.description === "string") {
        addEvent(evt.type as DashboardEvent["type"], evt.description);
      }
    }
  }
}

export function startDashboard(): void {
  stopDashboard();

  store.update((s) => ({ ...s, loading: true }));

  // Subscribe to push updates
  const client = getClient();
  if (client) {
    unsubscribePush = client.onPush(handlePush);

    const trySubscribe = (): void => {
      if (client.state === "connected") {
        client.call("system.subscribe").catch((err) => {
          clientLog("warn", "dashboard", "Failed to subscribe to system updates", err);
        });
      }
    };

    // Request subscription (fire-and-forget)
    trySubscribe();

    // Retry on reconnect
    const unsubscribeState = client.onStateChange((state) => {
      if (state === "connected") {
        trySubscribe();
      }
    });

    // Chain unsubscribe for state change handler
    const originalUnsubscribePush = unsubscribePush;
    unsubscribePush = () => {
      originalUnsubscribePush();
      unsubscribeState();
    };
  }

  // Initial fetch
  fetchStatus();

  // Periodic polling
  pollTimer = setInterval(() => {
    fetchStatus();
  }, POLL_INTERVAL_MS);
}

export function stopDashboard(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (unsubscribePush) {
    unsubscribePush();
    unsubscribePush = null;
  }
}

export function resetDashboard(): void {
  stopDashboard();
  store.set({ ...DEFAULT_STATE });
}

export const dashboardState = { subscribe: store.subscribe };

export const cognitiveState = derived(store, (s) => s.status.cognitiveState);
export const energyLevel = derived(store, (s) => s.status.energy);
export const activeTasks = derived(store, (s) => s.status.activeTasks);
export const memoryCount = derived(store, (s) => s.status.memoryCount);
export const uptimeMs = derived(store, (s) => s.status.uptimeMs);
export const connectedClients = derived(store, (s) => s.status.connectedClients);
export const recentEvents = derived(store, (s) => s.events);
export const serverVersion = derived(store, (s) => s.status.serverVersion);
export const connectedSince = derived(store, (s) => s.status.connectedSince);
export const latencyMs = derived(store, (s) => s.status.latencyMs);
export const dashboardLoading = derived(store, (s) => s.loading);
export const dashboardError = derived(store, (s) => s.error);
