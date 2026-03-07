/**
 * Settings store — persists gateway connection settings
 * to sessionStorage (cleared on window close to avoid token leakage).
 * Update preferences are persisted to localStorage (survive restarts).
 *
 * SECURITY NOTE (CLIENT-004): Token storage in sessionStorage is acceptable for
 * the desktop app because Tauri provides its own process-level sandboxing — the
 * WebView does not share storage with arbitrary browser tabs, and there is no
 * cross-origin risk from other websites. This is NOT safe for a regular web app
 * where sessionStorage is accessible to any XSS payload running in the same origin.
 * The web variant should migrate to httpOnly cookies or a server-side session once
 * the gateway supports cookie-based auth.
 */

import { writable } from "svelte/store";
import { clientLog } from "../logger";

export interface Settings {
  host: string;
  port: number;
  token: string;
  useTls: boolean;
}

export interface UpdateSettings {
  autoCheck: boolean;
  lastChecked: string | null;
}

/** localStorage key for non-sensitive connection settings (host, port, useTls). */
const CONNECTION_STORAGE_KEY = "eidolon-connection";
/** sessionStorage key for the auth token -- cleared on window close. */
const TOKEN_STORAGE_KEY = "eidolon-token";
const UPDATE_STORAGE_KEY = "eidolon-update-settings";
/** Allowed characters for hostname to prevent URL injection. */
const HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/;

const DEFAULT_SETTINGS: Settings = {
  host: "127.0.0.1",
  port: 8419,
  token: "",
  useTls: false,
};

const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  autoCheck: true,
  lastChecked: null,
};

function loadSettings(): Settings {
  let host = DEFAULT_SETTINGS.host;
  let port = DEFAULT_SETTINGS.port;
  let useTls = DEFAULT_SETTINGS.useTls;
  let token = DEFAULT_SETTINGS.token;

  // Load non-sensitive fields from localStorage (survives restarts)
  try {
    const stored = localStorage.getItem(CONNECTION_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<Settings>;
      if (typeof parsed.host === "string") host = parsed.host;
      if (typeof parsed.port === "number") port = parsed.port;
      if (typeof parsed.useTls === "boolean") useTls = parsed.useTls;
    }
  } catch (err) {
    clientLog("warn", "settings", "Failed to load connection settings from localStorage", err);
  }

  // Load token from sessionStorage (cleared on window close for security)
  try {
    const storedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (storedToken && typeof storedToken === "string") {
      token = storedToken;
    }
  } catch (err) {
    clientLog("warn", "settings", "Failed to load token from sessionStorage", err);
  }

  return { host, port, token, useTls };
}

function persistSettings(settings: Settings): void {
  // Non-sensitive fields go to localStorage (persist across restarts)
  try {
    localStorage.setItem(
      CONNECTION_STORAGE_KEY,
      JSON.stringify({ host: settings.host, port: settings.port, useTls: settings.useTls }),
    );
  } catch (err) {
    clientLog("warn", "settings", "Failed to persist connection settings to localStorage", err);
  }

  // Token stays in sessionStorage (cleared on window close)
  try {
    if (settings.token) {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, settings.token);
    } else {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    }
  } catch (err) {
    clientLog("warn", "settings", "Failed to persist token to sessionStorage", err);
  }
}

export const settingsStore = writable<Settings>(loadSettings());

export function updateSettings(updates: Partial<Settings>): void {
  settingsStore.update((current) => {
    const next = { ...current, ...updates };
    // Enforce input length limits to prevent storage abuse
    if (next.host.length > 253) next.host = next.host.slice(0, 253);
    if (!HOSTNAME_RE.test(next.host)) next.host = DEFAULT_SETTINGS.host;
    if (next.token.length > 512) next.token = next.token.slice(0, 512);
    if (next.port < 1 || next.port > 65535) next.port = DEFAULT_SETTINGS.port;
    persistSettings(next);
    return next;
  });
}

export function resetSettings(): void {
  const defaults = { ...DEFAULT_SETTINGS };
  settingsStore.set(defaults);
  persistSettings(defaults);
}

// --- Update settings (persisted to localStorage, not sessionStorage) ---

function loadUpdateSettings(): UpdateSettings {
  try {
    const stored = localStorage.getItem(UPDATE_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<UpdateSettings>;
      return {
        autoCheck: typeof parsed.autoCheck === "boolean" ? parsed.autoCheck : DEFAULT_UPDATE_SETTINGS.autoCheck,
        lastChecked: typeof parsed.lastChecked === "string" ? parsed.lastChecked : DEFAULT_UPDATE_SETTINGS.lastChecked,
      };
    }
  } catch (err) {
    clientLog("warn", "settings", "Failed to load update settings from localStorage", err);
  }
  return { ...DEFAULT_UPDATE_SETTINGS };
}

function persistUpdateSettings(settings: UpdateSettings): void {
  try {
    localStorage.setItem(UPDATE_STORAGE_KEY, JSON.stringify(settings));
  } catch (err) {
    clientLog("warn", "settings", "Failed to persist update settings to localStorage", err);
  }
}

export const updateSettingsStore = writable<UpdateSettings>(loadUpdateSettings());

export function setAutoCheck(enabled: boolean): void {
  updateSettingsStore.update((current) => {
    const next = { ...current, autoCheck: enabled };
    persistUpdateSettings(next);
    return next;
  });
}

export function setLastChecked(timestamp: string): void {
  updateSettingsStore.update((current) => {
    const next = { ...current, lastChecked: timestamp };
    persistUpdateSettings(next);
    return next;
  });
}
