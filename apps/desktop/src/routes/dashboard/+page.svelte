<script lang="ts">
import { onMount, onDestroy } from "svelte";
import {
  startDashboard,
  stopDashboard,
  cognitiveState,
  energyLevel,
  activeTasks,
  memoryCount,
  uptimeMs,
  connectedClients,
  recentEvents,
  serverVersion,
  connectedSince,
  latencyMs,
  dashboardError,
  type CognitiveState,
  type DashboardEvent,
} from "../../lib/stores/dashboard";
import { connectionState, isConnected } from "../../lib/stores/connection";

// ---- State color mapping ----

function brainStateColor(state: CognitiveState): string {
  switch (state) {
    case "perceiving":
    case "evaluating":
      return "var(--warning)";
    case "acting":
    case "reflecting":
      return "var(--success)";
    case "dreaming":
      return "#6c5ce7";
    case "idle":
    default:
      return "var(--text-secondary)";
  }
}

function brainStateCssClass(state: CognitiveState): string {
  switch (state) {
    case "perceiving":
    case "evaluating":
      return "thinking";
    case "acting":
    case "reflecting":
      return "active";
    case "dreaming":
      return "dreaming";
    case "idle":
    default:
      return "idle";
  }
}

function energyColor(current: number, max: number): string {
  const pct = max > 0 ? (current / max) * 100 : 0;
  if (pct > 60) return "var(--success)";
  if (pct > 30) return "var(--warning)";
  return "var(--error)";
}

function formatUptime(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatTimestamp(ts: number): string {
  if (ts <= 0) return "--";
  return new Date(ts).toLocaleTimeString();
}

function formatDateTimestamp(ts: number): string {
  if (ts <= 0) return "--";
  return new Date(ts).toLocaleString();
}

function eventTypeIcon(type: DashboardEvent["type"]): string {
  switch (type) {
    case "state_change": return "~";
    case "task": return ">";
    case "memory": return "*";
    case "learning": return "+";
    case "warning": return "!";
    case "error": return "x";
    case "info":
    default: return "-";
  }
}

function eventTypeClass(type: DashboardEvent["type"]): string {
  switch (type) {
    case "error": return "event-error";
    case "warning": return "event-warning";
    case "state_change": return "event-state";
    case "task": return "event-task";
    case "memory": return "event-memory";
    case "learning": return "event-learning";
    case "info":
    default: return "event-info";
  }
}

function platformIcon(platform: string): string {
  switch (platform.toLowerCase()) {
    case "desktop":
    case "tauri": return "[D]";
    case "web": return "[W]";
    case "ios":
    case "iphone": return "[i]";
    case "telegram": return "[T]";
    default: return "[?]";
  }
}

// ---- Lifecycle ----

onMount(() => {
  startDashboard();
});

onDestroy(() => {
  stopDashboard();
});

// ---- Live uptime ticker ----
let displayUptime = $state("0s");
let uptimeTicker: ReturnType<typeof setInterval> | null = null;
let lastUptimeMs = 0;
let lastUptimeFetchTime = 0;

$effect(() => {
  lastUptimeMs = $uptimeMs;
  lastUptimeFetchTime = Date.now();
});

onMount(() => {
  uptimeTicker = setInterval(() => {
    if (lastUptimeMs > 0) {
      const elapsed = Date.now() - lastUptimeFetchTime;
      displayUptime = formatUptime(lastUptimeMs + elapsed);
    }
  }, 1000);
});

onDestroy(() => {
  if (uptimeTicker) clearInterval(uptimeTicker);
});
</script>

<div class="dashboard">
  <!-- Header Section -->
  <header class="dashboard-header">
    <div class="brain-state">
      <span
        class="brain-dot {brainStateCssClass($cognitiveState)}"
        style="background-color: {brainStateColor($cognitiveState)}"
      ></span>
      <span class="brain-label">{$cognitiveState.charAt(0).toUpperCase() + $cognitiveState.slice(1)}</span>
    </div>
    <div class="header-meta">
      <span class="uptime-label">Uptime</span>
      <span class="uptime-value">{displayUptime}</span>
    </div>
    {#if !$isConnected}
      <div class="disconnected-banner">
        Not connected ({$connectionState})
      </div>
    {/if}
    {#if $dashboardError}
      <div class="error-banner">{$dashboardError}</div>
    {/if}
  </header>

  <!-- Status Cards -->
  <section class="cards">
    <!-- Energy -->
    <div class="card">
      <div class="card-header">
        <span class="card-icon">[E]</span>
        <span class="card-title">Energy</span>
      </div>
      <div class="card-body">
        <div class="energy-bar-track">
          <div
            class="energy-bar-fill"
            style="width: {$energyLevel.max > 0 ? ($energyLevel.current / $energyLevel.max) * 100 : 0}%; background-color: {energyColor($energyLevel.current, $energyLevel.max)}"
          ></div>
        </div>
        <span class="card-stat">{$energyLevel.current}<span class="card-stat-sub">/{$energyLevel.max}</span></span>
      </div>
    </div>

    <!-- Active Tasks -->
    <div class="card">
      <div class="card-header">
        <span class="card-icon">[T]</span>
        <span class="card-title">Active Tasks</span>
      </div>
      <div class="card-body">
        <span class="card-stat large">{$activeTasks}</span>
      </div>
    </div>

    <!-- Memories -->
    <div class="card">
      <div class="card-header">
        <span class="card-icon">[M]</span>
        <span class="card-title">Memories</span>
      </div>
      <div class="card-body">
        <span class="card-stat large">{$memoryCount.toLocaleString()}</span>
      </div>
    </div>

    <!-- Connected Clients -->
    <div class="card">
      <div class="card-header">
        <span class="card-icon">[C]</span>
        <span class="card-title">Clients</span>
      </div>
      <div class="card-body">
        <span class="card-stat large">{$connectedClients.length}</span>
        {#if $connectedClients.length > 0}
          <div class="client-list">
            {#each $connectedClients as client (client.id)}
              <span class="client-badge" title="{client.platform} ({client.id})">
                {platformIcon(client.platform)}
              </span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </section>

  <!-- Activity Feed + System Info -->
  <section class="bottom-row">
    <!-- Activity Feed -->
    <div class="activity-feed">
      <h2 class="section-title">Activity Feed</h2>
      <div class="feed-list">
        {#if $recentEvents.length === 0}
          <div class="feed-empty">No recent events</div>
        {:else}
          {#each $recentEvents as event (event.id)}
            <div class="feed-item {eventTypeClass(event.type)}">
              <span class="feed-icon">{eventTypeIcon(event.type)}</span>
              <span class="feed-time">{formatTimestamp(event.timestamp)}</span>
              <span class="feed-desc">{event.description}</span>
            </div>
          {/each}
        {/if}
      </div>
    </div>

    <!-- System Info -->
    <div class="system-info">
      <h2 class="section-title">System Info</h2>
      <div class="info-rows">
        <div class="info-row">
          <span class="info-label">Server Version</span>
          <span class="info-value">{$serverVersion}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Connected Since</span>
          <span class="info-value">{formatDateTimestamp($connectedSince)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Gateway Latency</span>
          <span class="info-value latency"
            >{$latencyMs > 0 ? `${$latencyMs}ms` : "--"}</span
          >
        </div>
        <div class="info-row">
          <span class="info-label">Connection</span>
          <span class="info-value">{$connectionState}</span>
        </div>
      </div>
    </div>
  </section>
</div>

<style>
  .dashboard {
    height: 100%;
    overflow-y: auto;
    padding: 20px 24px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  /* ---- Header ---- */
  .dashboard-header {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
  }

  .brain-state {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .brain-dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    flex-shrink: 0;
    transition: background-color 0.4s ease;
  }

  .brain-dot.active {
    box-shadow: 0 0 8px 2px var(--success);
    animation: pulse 2s ease-in-out infinite;
  }

  .brain-dot.thinking {
    box-shadow: 0 0 8px 2px var(--warning);
    animation: pulse 1.2s ease-in-out infinite;
  }

  .brain-dot.dreaming {
    box-shadow: 0 0 8px 2px #6c5ce7;
    animation: pulse 3s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .brain-label {
    font-size: 22px;
    font-weight: 700;
    color: var(--text-primary);
    transition: color 0.3s ease;
  }

  .header-meta {
    margin-left: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }

  .uptime-label {
    font-size: 11px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .uptime-value {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }

  .disconnected-banner {
    width: 100%;
    padding: 8px 12px;
    background: rgba(231, 76, 60, 0.15);
    border: 1px solid var(--error);
    border-radius: var(--radius);
    color: var(--error);
    font-size: 13px;
    text-align: center;
  }

  .error-banner {
    width: 100%;
    padding: 8px 12px;
    background: rgba(243, 156, 18, 0.15);
    border: 1px solid var(--warning);
    border-radius: var(--radius);
    color: var(--warning);
    font-size: 13px;
    text-align: center;
  }

  /* ---- Cards ---- */
  .cards {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }

  @media (max-width: 900px) {
    .cards {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 500px) {
    .cards {
      grid-template-columns: 1fr;
    }
  }

  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    transition: border-color 0.2s ease;
  }

  .card:hover {
    border-color: var(--accent);
  }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .card-icon {
    font-size: 13px;
    color: var(--accent);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .card-title {
    font-size: 12px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .card-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .card-stat {
    font-size: 20px;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }

  .card-stat.large {
    font-size: 28px;
  }

  .card-stat-sub {
    font-size: 14px;
    font-weight: 400;
    color: var(--text-secondary);
  }

  /* Energy bar */
  .energy-bar-track {
    width: 100%;
    height: 8px;
    background: var(--bg-primary);
    border-radius: 4px;
    overflow: hidden;
  }

  .energy-bar-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.6s ease, background-color 0.4s ease;
    min-width: 0;
  }

  /* Client badges */
  .client-list {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 2px;
  }

  .client-badge {
    font-size: 11px;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    padding: 2px 6px;
    border-radius: 3px;
    font-variant-numeric: tabular-nums;
  }

  /* ---- Bottom Row ---- */
  .bottom-row {
    display: grid;
    grid-template-columns: 1fr 280px;
    gap: 14px;
    flex: 1;
    min-height: 0;
  }

  @media (max-width: 700px) {
    .bottom-row {
      grid-template-columns: 1fr;
    }
  }

  .section-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
  }

  /* Activity Feed */
  .activity-feed {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    min-height: 200px;
    max-height: 400px;
  }

  .feed-list {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .feed-empty {
    color: var(--text-secondary);
    font-size: 13px;
    padding: 20px 0;
    text-align: center;
  }

  .feed-item {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 3px;
    font-size: 13px;
    transition: background-color 0.15s ease;
  }

  .feed-item:hover {
    background: var(--bg-tertiary);
  }

  .feed-icon {
    width: 16px;
    text-align: center;
    flex-shrink: 0;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .event-error .feed-icon { color: var(--error); }
  .event-warning .feed-icon { color: var(--warning); }
  .event-state .feed-icon { color: #6c5ce7; }
  .event-task .feed-icon { color: var(--accent); }
  .event-memory .feed-icon { color: var(--success); }
  .event-learning .feed-icon { color: #00cec9; }
  .event-info .feed-icon { color: var(--text-secondary); }

  .feed-time {
    font-size: 11px;
    color: var(--text-secondary);
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
    min-width: 70px;
  }

  .feed-desc {
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* System Info */
  .system-info {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }

  .info-rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .info-label {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .info-value {
    font-size: 13px;
    color: var(--text-primary);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .info-value.latency {
    color: var(--success);
  }
</style>
