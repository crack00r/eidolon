<script lang="ts">
import type { Snippet } from "svelte";
import { onMount } from "svelte";
import { getVersion } from "@tauri-apps/api/app";
import { connectionState } from "../lib/stores/connection";

interface Props {
  currentRoute: string;
  onNavigate: (route: string) => void;
  children: Snippet;
}

let { currentRoute, onNavigate, children }: Props = $props();

let appVersion = $state("...");
onMount(async () => {
  try {
    appVersion = await getVersion();
  } catch {
    appVersion = "dev";
  }
});

const navItems = [
  { route: "dashboard", label: "Dashboard", icon: "\u{25A6}" },
  { route: "chat", label: "Chat", icon: "\u{1F4AC}" },
  { route: "memory", label: "Memory", icon: "\u{1F9E0}" },
  { route: "learning", label: "Learning", icon: "\u{1F4D6}" },
  { route: "settings", label: "Settings", icon: "\u{2699}" },
] as const;

function stateColor(state: string): string {
  switch (state) {
    case "connected":
      return "var(--success)";
    case "connecting":
    case "authenticating":
      return "var(--warning)";
    case "error":
      return "var(--error)";
    default:
      return "var(--text-secondary)";
  }
}
</script>

<div class="layout">
  <a class="skip-link" href="#main-content">Skip to main content</a>

  <aside class="sidebar">
    <div class="sidebar-header">
      <h1 class="logo">Eidolon</h1>
      <div class="connection-status" role="status" aria-live="polite">
        <span
          class="status-dot"
          style="background-color: {stateColor($connectionState)}"
          aria-hidden="true"
        ></span>
        <span class="status-text">{$connectionState}</span>
      </div>
    </div>

    <nav class="nav" aria-label="Main navigation">
      {#each navItems as item}
        <button
          class="nav-item"
          class:active={currentRoute === item.route}
          aria-current={currentRoute === item.route ? "page" : undefined}
          onclick={() => onNavigate(item.route)}
        >
          <span class="nav-icon" aria-hidden="true">{item.icon}</span>
          <span class="nav-label">{item.label}</span>
        </button>
      {/each}
    </nav>

    <div class="sidebar-footer">
      <span class="version">v{appVersion}</span>
    </div>
  </aside>

  <main class="content" id="main-content">
    {@render children()}
  </main>
</div>

<style>
  .layout {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }

  .sidebar {
    width: var(--sidebar-width);
    min-width: var(--sidebar-width);
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    user-select: none;
  }

  .sidebar-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  .logo {
    font-size: 18px;
    font-weight: 700;
    color: var(--accent);
    margin-bottom: 8px;
  }

  .connection-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-text {
    text-transform: capitalize;
  }

  .nav {
    flex: 1;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: none;
    color: var(--text-secondary);
    transition: background-color 0.15s, color 0.15s;
    text-align: left;
    width: 100%;
  }

  .nav-item:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .nav-item.active {
    background: var(--bg-tertiary);
    color: var(--accent);
  }

  .nav-icon {
    font-size: 16px;
    width: 20px;
    text-align: center;
  }

  .nav-label {
    font-size: 14px;
  }

  .sidebar-footer {
    padding: 12px 16px;
    border-top: 1px solid var(--border);
  }

  .version {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .content {
    flex: 1;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .skip-link {
    position: absolute;
    left: -9999px;
    top: 0;
    z-index: 9999;
    padding: 8px 16px;
    background: var(--accent);
    color: white;
    font-weight: 600;
    text-decoration: none;
    border-radius: 0 0 var(--radius) 0;
  }

  .skip-link:focus {
    left: 0;
  }
</style>
