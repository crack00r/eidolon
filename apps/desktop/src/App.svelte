<script lang="ts">
import { onDestroy, onMount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import Layout from "./routes/+layout.svelte";
import DashboardPage from "./routes/dashboard/+page.svelte";
import ChatPage from "./routes/chat/+page.svelte";
import LearningPage from "./routes/learning/+page.svelte";
import MemoryPage from "./routes/memory/+page.svelte";
import SettingsPage from "./routes/settings/+page.svelte";
import RoleSelect from "./routes/onboarding/RoleSelect.svelte";
import ServerSetup from "./routes/onboarding/ServerSetup.svelte";
import ClientSetup from "./routes/onboarding/ClientSetup.svelte";
import { connect, getClient, onNewClient } from "./lib/stores/connection";
import { setupChatPushHandlers } from "./lib/stores/chat";
import { updateSettings } from "./lib/stores/settings";
import { clientLog } from "./lib/logger";

type AppState =
  | "loading"
  | "onboarding-role"
  | "onboarding-server"
  | "onboarding-client"
  | "running";

let appState = $state<AppState>("loading");
let currentRoute = $state("dashboard");
let loadError = $state<string | null>(null);
let daemonError = $state<string | null>(null);
let daemonRestarting = $state(false);

// Track daemon restart attempts to prevent crash loops (max 3 within 5 minutes)
const daemonRestartTimestamps: number[] = [];
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function navigate(route: string): void {
  currentRoute = route;
}

function handleRoleSelect(role: "server" | "client"): void {
  if (role === "server") {
    appState = "onboarding-server";
  } else {
    appState = "onboarding-client";
  }
}

function handleOnboardingBack(): void {
  appState = "onboarding-role";
}

async function autoConnect(role: string): Promise<void> {
  try {
    if (role === "server") {
      const gwConfig = await invoke<{ port: number; token: string; tls: boolean }>(
        "get_server_gateway_config"
      );
      updateSettings({
        host: "127.0.0.1",
        port: gwConfig.port ?? 8419,
        useTls: gwConfig.tls ?? false,
        ...(gwConfig.token ? { token: gwConfig.token } : {}),
      });
      connect();
    } else {
      const config = await invoke<{ host: string; port: number; token?: string; tls?: boolean }>(
        "get_client_config"
      );
      updateSettings({
        host: config.host,
        port: config.port,
        useTls: config.tls ?? false,
        ...(config.token ? { token: config.token } : {}),
      });
      connect();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    clientLog("error", "app", `Auto-connect failed: ${msg}`);
    daemonError = `Connection failed: ${msg}`;
  }
}

async function startDaemonWithConfig(): Promise<void> {
  const configPath = await invoke<string>("get_config_path");
  await invoke("start_daemon", { configPath });
}

/** Check if we can attempt a daemon restart (rate-limited to prevent crash loops). */
function canRestartDaemon(): boolean {
  const now = Date.now();
  // Remove timestamps outside the window
  while (daemonRestartTimestamps.length > 0 && now - daemonRestartTimestamps[0]! > RESTART_WINDOW_MS) {
    daemonRestartTimestamps.shift();
  }
  return daemonRestartTimestamps.length < MAX_RESTART_ATTEMPTS;
}

async function restartDaemon(): Promise<void> {
  if (daemonRestarting) return;
  daemonRestarting = true;
  daemonError = null;
  try {
    daemonRestartTimestamps.push(Date.now());
    try {
      await startDaemonWithConfig();
    } catch (startErr: unknown) {
      const startMsg = startErr instanceof Error ? startErr.message : String(startErr);
      // "Already running" is fine -- just reconnect
      if (!startMsg.toLowerCase().includes("already running")) {
        throw startErr;
      }
      clientLog("info", "app", "Daemon already running during restart, reconnecting...");
    }
    clientLog("info", "app", "Daemon restarted successfully");
    // Reconnect after restart
    const role = await invoke<string>("get_config_role");
    await autoConnect(role);
    wireChatPushHandlers();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    daemonError = `Failed to restart daemon: ${msg}`;
    clientLog("error", "app", `Daemon restart failed: ${msg}`);
  } finally {
    daemonRestarting = false;
  }
}

async function handleOnboardingComplete(): Promise<void> {
  let role: string;
  try {
    role = await invoke<string>("get_config_role");
    if (role === "server") {
      try {
        await startDaemonWithConfig();
      } catch (startErr: unknown) {
        const startMsg = startErr instanceof Error ? startErr.message : String(startErr);
        // "Already running" is fine after onboarding -- just connect
        if (!startMsg.toLowerCase().includes("already running")) {
          throw startErr;
        }
        clientLog("info", "app", "Daemon already running after onboarding, connecting...");
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    daemonError = `Failed to start daemon: ${msg}`;
    return;
  }
  appState = "running";
  await autoConnect(role);
  wireChatPushHandlers();
}

// Daemon-exit event listener cleanup
let unlistenDaemonExit: (() => void) | null = null;
// Chat push handler cleanup
let unsubChatPush: (() => void) | null = null;
// onNewClient callback cleanup
let unsubNewClient: (() => void) | null = null;

function wireChatPushHandlers(): void {
  // Clean up any previous subscription
  unsubChatPush?.();
  unsubChatPush = null;

  const client = getClient();
  if (client) {
    unsubChatPush = setupChatPushHandlers(client);
  }
}

// Re-register push handlers whenever a new GatewayClient is created (M-2 fix).
unsubNewClient = onNewClient((client) => {
  unsubChatPush?.();
  unsubChatPush = setupChatPushHandlers(client);
});

onDestroy(() => {
  unlistenDaemonExit?.();
  unsubChatPush?.();
  unsubNewClient?.();
});

onMount(async () => {
  // Listen for daemon-exit events from the Rust backend
  unlistenDaemonExit = await listen<{ code: number | null; signal: number | null; message: string }>("daemon-exit", (event) => {
    const { code, message } = event.payload;
    daemonError = `Daemon exited unexpectedly (code ${code ?? "unknown"}): ${message}`;
    clientLog("error", "app", `Daemon exit: code=${code ?? "unknown"} message=${message}`);

    // Auto-restart on unexpected exit (non-zero code or signal), rate-limited
    const isUnexpected = code !== 0;
    if (isUnexpected && appState === "running" && canRestartDaemon()) {
      clientLog("info", "app", "Attempting automatic daemon restart in 3 seconds...");
      setTimeout(() => {
        restartDaemon();
      }, 3000);
    }
  });

  try {
    const configExists = await invoke<boolean>("check_config_exists");
    if (!configExists) {
      appState = "onboarding-role";
      return;
    }

    // Validate config completeness
    const validation = await invoke<{ valid: boolean; issues: string[] }>("validate_config");
    if (!validation.valid) {
      console.warn("Config incomplete:", validation.issues);
      appState = "onboarding-role";
      return;
    }

    const role = await invoke<string>("get_config_role");
    if (role === "server") {
      try {
        await startDaemonWithConfig();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // "Already running" is not an error -- just reconnect to existing daemon
        if (!msg.toLowerCase().includes("already running")) {
          daemonError = `Failed to start daemon: ${msg}`;
        } else {
          clientLog("info", "app", "Daemon already running, reconnecting...");
        }
      }
    }
    appState = "running";
    if (!daemonError) {
      await autoConnect(role);
      wireChatPushHandlers();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    loadError = msg;
    // Fall through to onboarding if config check fails
    appState = "onboarding-role";
  }
});
</script>

{#if appState === "loading"}
  <div class="loading-screen">
    <span class="loading-logo">Eidolon</span>
    {#if loadError}
      <p class="loading-error">{loadError}</p>
    {/if}
  </div>
{:else if appState === "onboarding-role"}
  <RoleSelect onSelect={handleRoleSelect} />
{:else if appState === "onboarding-server"}
  <ServerSetup onComplete={handleOnboardingComplete} onBack={handleOnboardingBack} />
{:else if appState === "onboarding-client"}
  <ClientSetup onComplete={handleOnboardingComplete} onBack={handleOnboardingBack} />
{:else}
  <Layout {currentRoute} onNavigate={navigate}>
    {#if daemonError}
      <div class="daemon-error-banner" role="alert">
        <strong>Daemon error:</strong> {daemonError}
        <button
          class="daemon-error-restart"
          onclick={() => restartDaemon()}
          disabled={daemonRestarting}
        >
          {daemonRestarting ? "Restarting..." : "Restart"}
        </button>
        <button class="daemon-error-dismiss" onclick={() => (daemonError = null)}>Dismiss</button>
      </div>
    {/if}
    {#if currentRoute === "dashboard"}
      <DashboardPage />
    {:else if currentRoute === "chat"}
      <ChatPage />
    {:else if currentRoute === "memory"}
      <MemoryPage />
    {:else if currentRoute === "learning"}
      <LearningPage />
    {:else if currentRoute === "settings"}
      <SettingsPage />
    {/if}
  </Layout>
{/if}

<style>
  .loading-screen {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: var(--bg-primary);
  }

  .loading-logo {
    font-size: var(--ed-text-2xl);
    font-weight: var(--ed-weight-bold);
    color: var(--accent);
  }

  .loading-error {
    font-size: var(--ed-text-sm);
    color: var(--error);
    max-width: 400px;
    text-align: center;
  }

  .daemon-error-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--error-bg, rgba(239, 68, 68, 0.1));
    border: 1px solid var(--error, #ef4444);
    border-radius: 8px;
    color: var(--error, #ef4444);
    font-size: var(--ed-text-sm);
    margin: 8px 16px;
  }

  .daemon-error-restart {
    margin-left: auto;
    background: none;
    border: 1px solid currentColor;
    border-radius: 4px;
    color: inherit;
    padding: 4px 10px;
    font-size: var(--ed-text-xs);
    cursor: pointer;
    font-weight: 600;
  }

  .daemon-error-restart:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .daemon-error-restart:hover:not(:disabled) {
    opacity: 0.8;
  }

  .daemon-error-dismiss {
    background: none;
    border: 1px solid currentColor;
    border-radius: 4px;
    color: inherit;
    padding: 4px 10px;
    font-size: var(--ed-text-xs);
    cursor: pointer;
  }

  .daemon-error-dismiss:hover {
    opacity: 0.8;
  }
</style>
