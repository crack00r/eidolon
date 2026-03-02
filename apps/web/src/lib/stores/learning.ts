/**
 * Learning store — manages self-learning discovery items
 * and user approval/rejection workflow.
 */

import { derived, writable } from "svelte/store";
import { clientLog } from "$lib/logger";
import { sanitizeErrorForDisplay } from "$lib/utils";
import { getClient } from "./connection";

export type SafetyClassification = "safe" | "review" | "unsafe";

export interface LearningItem {
  id: string;
  title: string;
  description: string;
  source: string;
  relevanceScore: number;
  safety: SafetyClassification;
  discoveredAt: number;
  status: "pending" | "approved" | "rejected";
}

const itemsStore = writable<LearningItem[]>([]);
const loadingStore = writable(false);
const errorStore = writable<string | null>(null);

export async function fetchPendingItems(): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  loadingStore.set(true);
  errorStore.set(null);

  try {
    const response = await client.call<{ items: LearningItem[] }>("learning.listPending");
    itemsStore.set(response.items);
  } catch (err) {
    clientLog("error", "learning", "fetchPendingItems failed", err);
    const msg = sanitizeErrorForDisplay(err, "Failed to fetch items");
    errorStore.set(msg);
  } finally {
    loadingStore.set(false);
  }
}

export async function approveItem(id: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    throw new Error("Not connected to gateway");
  }

  await client.call("learning.approve", { id });

  itemsStore.update((items) => items.map((item) => (item.id === id ? { ...item, status: "approved" as const } : item)));
}

export async function rejectItem(id: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    throw new Error("Not connected to gateway");
  }

  await client.call("learning.reject", { id });

  itemsStore.update((items) => items.map((item) => (item.id === id ? { ...item, status: "rejected" as const } : item)));
}

export const learningItems = { subscribe: itemsStore.subscribe };
export const isLoadingLearning = { subscribe: loadingStore.subscribe };
export const learningError = { subscribe: errorStore.subscribe };

export const pendingCount = derived(itemsStore, (items) => items.filter((i) => i.status === "pending").length);
