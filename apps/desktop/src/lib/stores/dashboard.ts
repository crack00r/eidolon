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

function createEvent(
  type: DashboardEvent["type"],
  description: string,
): DashboardEvent {
  return {
    id: nextEventId(),
    timestamp: Date.now(),
    type,
    description,
  };
}

/** Prepend new events to an existing event list, returning the merged array (capped). */
function mergeEvents(existing: DashboardEvent[], newEvents: DashboardEvent[]): DashboardEvent[] {
  return [...newEvents, ...existing].slice(0, MAX_EVENTS);
}

function parseStatus(raw: Record<string, unknown>): SystemStatus {
  const energy = raw.energy as { current?: number; max?: number } | undefined;
  const clientsRaw = raw.connectedClients;

  // Backend may return `state` (string like "running") instead of `cognitiveState` (PEAR enum).
  // Map known backend states to our CognitiveState type.
  const VALID_COGNITIVE_STATES = new Set<string>(["idle", "perceiving", "evaluating", "acting", "reflecting", "dreaming"]);
  const rawState = (raw.cognitiveState ?? raw.state ?? "idle") as string;
  const cognitiveState: CognitiveState = VALID_COGNITIVE_STATES.has(rawState)
    ? rawState as CognitiveState
    : "idle";

  // Backend may return connectedClients as a number (count) or as an array of objects.
  let connectedClients: Array<{ id: string; platform: string }> = [];
  if (Array.isArray(clientsRaw)) {
    connectedClients = (clientsRaw as Array<Record<string, unknown>>).map((c) => ({
      id: typeof c.id === "string" ? c.id : "unknown",
      platform: typeof c.platform === "string" ? c.platform : "unknown",
    }));
  } else if (typeof clientsRaw === "number" && clientsRaw > 0) {
    // Synthesize placeholder entries from the count so the UI shows a number
    connectedClients = Array.from({ length: clientsRaw }, (_, i) => ({
      id: `client-${i}`,
      platform: "unknown",
    }));
  }

  return {
    cognitiveState,
    energy: {
      current: typeof energy?.current === "number" ? energy.current : 0,
      max: typeof energy?.max === "number" ? energy.max : 100,
    },
    activeTasks: typeof raw.activeTasks === "number" ? raw.activeTasks : 0,
    memoryCount: typeof raw.memoryCount === "number" ? raw.memoryCount : 0,
    uptimeMs: typeof raw.uptime === "number" ? raw.uptime : 0,
    connectedClients,
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
      // Detect state changes and collect events atomically (no nested store.update)
      const newEvents: DashboardEvent[] = [];
      if (s.status.cognitiveState !== status.cognitiveState) {
        newEvents.push(createEvent("state_change", `State changed: ${s.status.cognitiveState} → ${status.cognitiveState}`));
      }
      return {
        ...s,
        status,
        events: newEvents.length > 0 ? mergeEvents(s.events, newEvents) : s.events,
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

  // Collect all events (state change + server-sent) to apply in a single atomic update
  const serverEvents: DashboardEvent[] = [];
  if (Array.isArray(params.recentEvents)) {
    for (const evt of params.recentEvents as Array<Record<string, unknown>>) {
      if (typeof evt.type === "string" && typeof evt.description === "string") {
        serverEvents.push(createEvent(evt.type as DashboardEvent["type"], evt.description));
      }
    }
  }

  store.update((s) => {
    const newEvents: DashboardEvent[] = [];
    if (s.status.cognitiveState !== status.cognitiveState) {
      newEvents.push(createEvent("state_change", `State changed: ${s.status.cognitiveState} → ${status.cognitiveState}`));
    }
    newEvents.push(...serverEvents);

    return {
      ...s,
      status,
      events: newEvents.length > 0 ? mergeEvents(s.events, newEvents) : s.events,
      lastUpdated: Date.now(),
      error: null,
    };
  });
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

    // Retry on reconnect -- also fetch status immediately so the dashboard
    // doesn't show stale defaults until the next polling cycle (M-7 fix).
    const unsubscribeState = client.onStateChange((state) => {
      if (state === "connected") {
        trySubscribe();
        fetchStatus();
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
