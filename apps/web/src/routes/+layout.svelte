<script lang="ts">
import "../app.css";
import type { Snippet } from "svelte";
import { page } from "$app/stores";
import { connectionState } from "$lib/stores/connection";

interface Props {
  children: Snippet;
}

let { children }: Props = $props();

const navItems = [
  { href: "/chat", label: "Chat", icon: "\u{1F4AC}" },
  { href: "/memory", label: "Memory", icon: "\u{1F9E0}" },
  { href: "/learning", label: "Learning", icon: "\u{1F4D6}" },
  { href: "/settings", label: "Settings", icon: "\u{2699}" },
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

function isActive(pathname: string, href: string): boolean {
  return pathname.startsWith(href);
}
</script>

<div class="layout">
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1 class="logo">Eidolon</h1>
      <span class="logo-sub">Web</span>
      <div class="connection-status">
        <span
          class="status-dot"
          style="background-color: {stateColor($connectionState)}"
        ></span>
        <span class="status-text">{$connectionState}</span>
      </div>
    </div>

    <nav class="nav">
      {#each navItems as item}
        <a
          class="nav-item"
          class:active={isActive($page.url.pathname, item.href)}
          href={item.href}
        >
          <span class="nav-icon">{item.icon}</span>
          <span class="nav-label">{item.label}</span>
        </a>
      {/each}
    </nav>

    <div class="sidebar-footer">
      <span class="version">v0.1.0</span>
    </div>
  </aside>

  <main class="content">
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
    margin-bottom: 2px;
    display: inline;
  }

  .logo-sub {
    font-size: 11px;
    color: var(--text-secondary);
    margin-left: 6px;
    vertical-align: super;
  }

  .connection-status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 8px;
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
    color: var(--text-secondary);
    transition: background-color 0.15s, color 0.15s;
    text-decoration: none;
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
</style>
