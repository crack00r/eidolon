/**
 * Memory search store — manages memory browsing and search
 * against the Core gateway's memory engine.
 */

import { writable } from "svelte/store";
import { clientLog } from "../logger";
import { sanitizeErrorForDisplay } from "../utils";
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

const deletingStore = writable(false);
const editingStore = writable(false);

export async function deleteMemory(id: string): Promise<boolean> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return false;
  }

  deletingStore.set(true);
  errorStore.set(null);

  try {
    await client.call("memory.delete", { id });
    resultsStore.update((items) => items.filter((item) => item.id !== id));
    selectedStore.update((selected) => (selected?.id === id ? null : selected));
    return true;
  } catch (err) {
    clientLog("error", "memory", "deleteMemory failed", err);
    const msg = sanitizeErrorForDisplay(err, "Delete failed");
    errorStore.set(msg);
    return false;
  } finally {
    deletingStore.set(false);
  }
}

export async function editMemory(
  id: string,
  updates: { content?: string; importance?: number },
): Promise<boolean> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return false;
  }

  editingStore.set(true);
  errorStore.set(null);

  try {
    const response = await client.call<{ item: MemoryItem }>("memory.update", { id, ...updates });
    resultsStore.update((items) =>
      items.map((item) => (item.id === id ? response.item : item)),
    );
    selectedStore.update((selected) => (selected?.id === id ? response.item : selected));
    return true;
  } catch (err) {
    clientLog("error", "memory", "editMemory failed", err);
    const msg = sanitizeErrorForDisplay(err, "Update failed");
    errorStore.set(msg);
    return false;
  } finally {
    editingStore.set(false);
  }
}

export const memoryResults = { subscribe: resultsStore.subscribe };
export const memoryQuery = { subscribe: queryStore.subscribe };
export const isSearching = { subscribe: searchingStore.subscribe };
export const memoryError = { subscribe: errorStore.subscribe };
export const selectedMemory = { subscribe: selectedStore.subscribe };
export const isDeleting = { subscribe: deletingStore.subscribe };
export const isEditing = { subscribe: editingStore.subscribe };
