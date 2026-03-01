/**
 * Settings store — persists gateway connection settings
 * to localStorage.
 */

import { writable } from "svelte/store";

export interface Settings {
  host: string;
  port: number;
  token: string;
  useTls: boolean;
}

const STORAGE_KEY = "eidolon-settings";

const DEFAULT_SETTINGS: Settings = {
  host: "127.0.0.1",
  port: 8419,
  token: "",
  useTls: true,
};

function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<Settings>;
      return {
        host: typeof parsed.host === "string" ? parsed.host : DEFAULT_SETTINGS.host,
        port: typeof parsed.port === "number" ? parsed.port : DEFAULT_SETTINGS.port,
        token: typeof parsed.token === "string" ? parsed.token : DEFAULT_SETTINGS.token,
        useTls: typeof parsed.useTls === "boolean" ? parsed.useTls : DEFAULT_SETTINGS.useTls,
      };
    }
  } catch {
    // Ignore parse errors, use defaults
  }
  return { ...DEFAULT_SETTINGS };
}

function persistSettings(settings: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors (e.g. quota exceeded)
  }
}

export const settingsStore = writable<Settings>(loadSettings());

export function updateSettings(updates: Partial<Settings>): void {
  settingsStore.update((current) => {
    const next = { ...current, ...updates };
    persistSettings(next);
    return next;
  });
}

export function resetSettings(): void {
  const defaults = { ...DEFAULT_SETTINGS };
  settingsStore.set(defaults);
  persistSettings(defaults);
}
