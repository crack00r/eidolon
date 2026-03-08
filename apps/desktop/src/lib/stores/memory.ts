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
    const response = await client.call<{
      results: Array<Record<string, unknown>>;
      total: number;
    }>("memory.search", {
      query,
      limit: 50,
    });
    // Map backend response shape to frontend MemoryItem interface.
    // Backend returns `confidence` (0-1 float); frontend expects `importance`.
    // Backend returns `layer` alongside `type`; `metadata` is not returned.
    const items: MemoryItem[] = response.results.map((r) => ({
      id: String(r.id ?? ""),
      type: (["episodic", "semantic", "procedural", "working", "meta"].includes(r.type as string)
        ? r.type
        : "semantic") as MemoryItem["type"],
      content: String(r.content ?? ""),
      importance: typeof r.confidence === "number" ? r.confidence : (typeof r.importance === "number" ? r.importance : 0),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
      metadata: typeof r.metadata === "object" && r.metadata !== null ? r.metadata as Record<string, unknown> : undefined,
    }));
    resultsStore.set(items);
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

export const memoryResults = { subscribe: resultsStore.subscribe };
export const memoryQuery = { subscribe: queryStore.subscribe };
export const isSearching = { subscribe: searchingStore.subscribe };
export const memoryError = { subscribe: errorStore.subscribe };
export const selectedMemory = { subscribe: selectedStore.subscribe };
export const isDeleting = { subscribe: deletingStore.subscribe };
