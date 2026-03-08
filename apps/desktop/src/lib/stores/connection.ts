/**
 * Connection state store — manages the GatewayClient instance
 * and exposes reactive connection state.
 */

import { derived, get, writable } from "svelte/store";
import { type ConnectionState, GatewayClient, type GatewayConfig } from "../api";
import { settingsStore } from "./settings";
import { clearStreamingState } from "./chat";

const clientStore = writable<GatewayClient | null>(null);
const stateStore = writable<ConnectionState>("disconnected");
const errorStore = writable<string | null>(null);

/** Callbacks to run when a new client instance is created. */
const onNewClientCallbacks: Array<(client: GatewayClient) => void> = [];

/** Register a callback that fires when a new GatewayClient is created (e.g., to re-register push handlers).
 * Returns an unsubscribe function to remove the callback. */
export function onNewClient(callback: (client: GatewayClient) => void): () => void {
  onNewClientCallbacks.push(callback);
  return () => {
    const idx = onNewClientCallbacks.indexOf(callback);
    if (idx !== -1) onNewClientCallbacks.splice(idx, 1);
  };
}

function createClient(config: GatewayConfig): GatewayClient {
  const client = new GatewayClient(config);

  client.onStateChange((state) => {
    stateStore.set(state);
    if (state === "error") {
      errorStore.set("Connection failed. Check that the server is running and reachable.");
      // Clear streaming state so UI is not stuck on "Thinking..."
      clearStreamingState();
    } else if (state === "disconnected") {
      // Clear streaming state on disconnect
      clearStreamingState();
    } else if (state === "connected") {
      errorStore.set(null);
    }
  });

  // Notify listeners (e.g., chat push handler registration)
  for (const cb of onNewClientCallbacks) {
    cb(client);
  }

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
