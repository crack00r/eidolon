<script lang="ts">
import { onMount } from "svelte";
import { invoke } from "@tauri-apps/api/core";
import Layout from "./routes/+layout.svelte";
import DashboardPage from "./routes/dashboard/+page.svelte";
import ChatPage from "./routes/chat/+page.svelte";
import LearningPage from "./routes/learning/+page.svelte";
import MemoryPage from "./routes/memory/+page.svelte";
import SettingsPage from "./routes/settings/+page.svelte";
import RoleSelect from "./routes/onboarding/RoleSelect.svelte";
import ServerSetup from "./routes/onboarding/ServerSetup.svelte";
import ClientSetup from "./routes/onboarding/ClientSetup.svelte";
import { connect } from "./lib/stores/connection";
import { updateSettings } from "./lib/stores/settings";

type AppState =
  | "loading"
  | "onboarding-role"
  | "onboarding-server"
  | "onboarding-client"
  | "running";

let appState = $state<AppState>("loading");
let currentRoute = $state("dashboard");
let loadError = $state<string | null>(null);

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

async function autoConnect(role: string): Promise<void> {
  try {
    if (role === "server") {
      updateSettings({ host: "127.0.0.1", port: 8419, useTls: false });
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
  } catch {
    // Non-fatal -- dashboard will show connection status
  }
}

async function handleOnboardingComplete(): Promise<void> {
  try {
    const role = await invoke<string>("get_config_role");
    if (role === "server") {
      await invoke("start_daemon");
    }
  } catch {
    // Non-fatal -- dashboard will show connection status
  }
  appState = "running";
  const role = await invoke<string>("get_config_role").catch(() => "server");
  autoConnect(role);
}

onMount(async () => {
  try {
    const configExists = await invoke<boolean>("check_config_exists");
    if (!configExists) {
      appState = "onboarding-role";
      return;
    }

    const role = await invoke<string>("get_config_role");
    if (role === "server") {
      try {
        await invoke("start_daemon");
      } catch {
        // Non-fatal -- dashboard will show the error state
      }
    }
    appState = "running";
    autoConnect(role);
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
  <ServerSetup onComplete={handleOnboardingComplete} />
{:else if appState === "onboarding-client"}
  <ClientSetup onComplete={handleOnboardingComplete} />
{:else}
  <Layout {currentRoute} onNavigate={navigate}>
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
</style>
