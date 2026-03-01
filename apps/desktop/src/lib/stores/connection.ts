/**
 * Connection state store — manages the GatewayClient instance
 * and exposes reactive connection state.
 */

import { writable, derived, get } from "svelte/store";
import { GatewayClient, type ConnectionState, type GatewayConfig } from "../api";
import { settingsStore } from "./settings";

const clientStore = writable<GatewayClient | null>(null);
const stateStore = writable<ConnectionState>("disconnected");
const errorStore = writable<string | null>(null);

function createClient(config: GatewayConfig): GatewayClient {
  const client = new GatewayClient(config);

  client.onStateChange((state) => {
    stateStore.set(state);
    if (state === "error") {
      errorStore.set("Connection failed");
    } else if (state === "connected") {
      errorStore.set(null);
    }
  });

  return client;
}

export function connect(): void {
  const settings = get(settingsStore);
  const config: GatewayConfig = {
    host: settings.host,
    port: settings.port,
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
