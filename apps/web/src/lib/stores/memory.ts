/**
 * Memory search store — manages memory browsing and search
 * against the Core gateway's memory engine.
 */

import { writable } from "svelte/store";
import { clientLog } from "$lib/logger";
import { sanitizeErrorForDisplay } from "$lib/utils";
import { getClient } from "./connection";

export interface MemoryItem {
  id: string;
  type: "episodic" | "semantic" | "procedural" | "working" | "meta";
  content: string;
  importance: number;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

const resultsStore = writable<MemoryItem[]>([]);
const queryStore = writable("");
const searchingStore = writable(false);
const errorStore = writable<string | null>(null);
const selectedStore = writable<MemoryItem | null>(null);

export async function searchMemory(query: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  queryStore.set(query);

  if (!query.trim()) {
    resultsStore.set([]);
    return;
  }

  searchingStore.set(true);
  errorStore.set(null);

  try {
    const response = await client.call<{ items: MemoryItem[] }>("memory.search", {
      query,
      limit: 50,
    });
    resultsStore.set(response.items);
  } catch (err) {
    clientLog("error", "memory", "searchMemory failed", err);
    const msg = sanitizeErrorForDisplay(err, "Search failed");
    errorStore.set(msg);
    resultsStore.set([]);
  } finally {
    searchingStore.set(false);
  }
}

export function selectMemoryItem(item: MemoryItem | null): void {
  selectedStore.set(item);
}

export function clearSearch(): void {
  queryStore.set("");
  resultsStore.set([]);
  errorStore.set(null);
  selectedStore.set(null);
}

export const memoryResults = { subscribe: resultsStore.subscribe };
export const memoryQuery = { subscribe: queryStore.subscribe };
export const isSearching = { subscribe: searchingStore.subscribe };
export const memoryError = { subscribe: errorStore.subscribe };
export const selectedMemory = { subscribe: selectedStore.subscribe };
