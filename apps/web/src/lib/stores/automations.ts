/**
 * Automations store -- manages Home Automation scenes and
 * scheduled tasks via the gateway.
 */

import { writable } from "svelte/store";
import { clientLog } from "$lib/logger";
import { sanitizeErrorForDisplay } from "$lib/utils";
import { getClient } from "./connection";

export interface AutomationScene {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule?: string;
  lastExecutedAt?: number;
  createdAt: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  type: "once" | "recurring" | "conditional";
  cron?: string;
  runAt?: number;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
}

const scenesStore = writable<AutomationScene[]>([]);
const tasksStore = writable<ScheduledTask[]>([]);
const loadingStore = writable(false);
const errorStore = writable<string | null>(null);

export async function fetchScenes(enabledOnly?: boolean): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  loadingStore.set(true);
  errorStore.set(null);

  try {
    const response = await client.call<{ items: AutomationScene[] }>(
      "automation.list",
      enabledOnly !== undefined ? { enabledOnly } : {},
    );
    scenesStore.set(response.items);
  } catch (err) {
    clientLog("error", "automations", "fetchScenes failed", err);
    const msg = sanitizeErrorForDisplay(err, "Failed to fetch automations");
    errorStore.set(msg);
  } finally {
    loadingStore.set(false);
  }
}

export async function createScene(input: string, deliverTo?: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  try {
    await client.call("automation.create", {
      input,
      ...(deliverTo ? { deliverTo } : {}),
    });

    // Re-fetch to get the server-generated scene
    await fetchScenes();
  } catch (err) {
    clientLog("error", "automations", "createScene failed", err);
    errorStore.set(sanitizeErrorForDisplay(err, "Failed to create scene"));
  }
}

export async function deleteScene(automationId: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  try {
    await client.call("automation.delete", { automationId });

    scenesStore.update((scenes) =>
      scenes.filter((s) => s.id !== automationId),
    );
  } catch (err) {
    clientLog("error", "automations", "deleteScene failed", err);
    errorStore.set(sanitizeErrorForDisplay(err, "Failed to delete scene"));
  }
}

export async function executeScene(automationId: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    errorStore.set("Not connected to gateway");
    return;
  }

  try {
    // Use brain.triggerAction to execute a scene
    await client.call("brain.triggerAction", {
      action: "ha_scene",
      args: { automationId },
    });
  } catch (err) {
    clientLog("error", "automations", "executeScene failed", err);
    errorStore.set(sanitizeErrorForDisplay(err, "Failed to execute scene"));
  }
}

export const automationScenes = { subscribe: scenesStore.subscribe };
export const scheduledTasks = { subscribe: tasksStore.subscribe };
export const isLoadingAutomations = { subscribe: loadingStore.subscribe };
export const automationError = { subscribe: errorStore.subscribe };
