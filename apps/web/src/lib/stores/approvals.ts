/**
 * Approvals store -- manages pending approval requests
 * and user approve/reject workflow via the gateway.
 */

import { derived, writable } from "svelte/store";
import { clientLog } from "$lib/logger";
import { sanitizeErrorForDisplay } from "$lib/utils";
import { getClient } from "./connection";

export type ApprovalLevel = "safe" | "needs_approval" | "dangerous";

export interface ApprovalItem {
  id: string;
  action: string;
  description: string;
  level: ApprovalLevel;
  channel: string;
  timeoutAt: number;
  escalationLevel: number;
  createdAt: number;
  status: "pending" | "approved" | "denied";
  respondedBy?: string;
}

const itemsStore = writable<ApprovalItem[]>([]);
const loadingStore = writable(false);
const errorStore = writable<string | null>(null);

export async function fetchApprovals(status?: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  loadingStore.set(true);
  errorStore.set(null);

  try {
    const response = await client.call<{ items: ApprovalItem[] }>(
      "approval.list",
      status ? { status } : {},
    );
    itemsStore.set(response.items);
  } catch (err) {
    clientLog("error", "approvals", "fetchApprovals failed", err);
    const msg = sanitizeErrorForDisplay(err, "Failed to fetch approvals");
    errorStore.set(msg);
  } finally {
    loadingStore.set(false);
  }
}

export async function approveItem(requestId: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  try {
    await client.call("approval.respond", { requestId, approved: true });

    itemsStore.update((items) =>
      items.map((item) =>
        item.id === requestId ? { ...item, status: "approved" as const } : item,
      ),
    );
  } catch (err) {
    clientLog("error", "approvals", "approveItem failed", err);
    errorStore.set(sanitizeErrorForDisplay(err, "Failed to approve item"));
  }
}

export async function rejectItem(requestId: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  try {
    await client.call("approval.respond", { requestId, approved: false });

    itemsStore.update((items) =>
      items.map((item) =>
        item.id === requestId ? { ...item, status: "denied" as const } : item,
      ),
    );
  } catch (err) {
    clientLog("error", "approvals", "rejectItem failed", err);
    errorStore.set(sanitizeErrorForDisplay(err, "Failed to reject item"));
  }
}

export const approvalItems = { subscribe: itemsStore.subscribe };
export const isLoadingApprovals = { subscribe: loadingStore.subscribe };
export const approvalError = { subscribe: errorStore.subscribe };

export const pendingApprovalCount = derived(
  itemsStore,
  (items) => items.filter((i) => i.status === "pending").length,
);
