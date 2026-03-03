/**
 * Connection state store — manages the GatewayClient instance
 * and exposes reactive connection state.
 *
 * Also registers push event handlers for real-time updates
 * to approval, health, and automation stores.
 */

import { derived, get, writable } from "svelte/store";
import { type ConnectionState, GatewayClient, type GatewayConfig } from "$lib/api";
import { clientLog } from "$lib/logger";
import { settingsStore } from "./settings";
import { fetchApprovals } from "./approvals";
import { fetchHealth } from "./health";
import { fetchScenes } from "./automations";

const clientStore = writable<GatewayClient | null>(null);
const stateStore = writable<ConnectionState>("disconnected");
const errorStore = writable<string | null>(null);

/** Tracks push handler unsubscribe functions so we only register once. */
let pushUnsubscribes: Array<() => void> = [];

function registerPushHandlers(client: GatewayClient): void {
  // Clear any previous handlers
  for (const unsub of pushUnsubscribes) {
    unsub();
  }
  pushUnsubscribes = [];

  // Approval events: refresh approval list when new requests arrive or are resolved
  pushUnsubscribes.push(
    client.on("push.approvalRequested", () => {
      clientLog("info", "connection", "Push: approval requested, refreshing");
      fetchApprovals();
    }),
  );
  pushUnsubscribes.push(
    client.on("push.approvalResolved", () => {
      clientLog("info", "connection", "Push: approval resolved, refreshing");
      fetchApprovals();
    }),
  );
}

function createClient(config: GatewayConfig): GatewayClient {
  const client = new GatewayClient(config);

  client.onStateChange((state) => {
    stateStore.set(state);
    if (state === "error") {
      errorStore.set("Connection failed");
    } else if (state === "connected") {
      errorStore.set(null);
      registerPushHandlers(client);
    }
  });

  return client;
}

export function connect(): void {
  const settings = get(settingsStore);
  const config: GatewayConfig = {
    host: settings.host,
    port: settings.port,
    useTls: settings.useTls,
    ...(settings.token ? { token: settings.token } : {}),
  };

  let client = get(clientStore);

  if (client) {
    client.disconnect();
    client.updateConfig(config);
  } else {
    client = createClient(config);
    clientStore.set(client);
  }

  client.connect();
}

export function disconnect(): void {
  const client = get(clientStore);
  if (client) {
    client.disconnect();
  }
}

export function getClient(): GatewayClient | null {
  return get(clientStore);
}

export const connectionState = { subscribe: stateStore.subscribe };
export const connectionError = { subscribe: errorStore.subscribe };

export const isConnected = derived(stateStore, (state) => state === "connected");
