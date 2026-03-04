<script lang="ts">
import { onMount, onDestroy } from "svelte";
import { clientLog } from "$lib/logger";
import { isConnected } from "$lib/stores/connection";
import {
  startHealthRefresh,
  stopHealthRefresh,
  healthData,
  isLoadingHealth,
  healthError,
  overallStatus,
  circuitBreakers,
  gpuWorkers,
  tokenUsage,
  eventQueueDepth,
  memoryStats,
  errorRate,
  type CircuitState,
  type GpuWorkerInfo,
} from "$lib/stores/health";
import MetricsChart from "$lib/components/MetricsChart.svelte";

function statusColor(status: string): string {
  switch (status) {
    case "healthy":
    case "online":
    case "pass":
      return "var(--success)";
    case "degraded":
    case "warn":
      return "var(--warning)";
    case "unhealthy":
    case "offline":
    case "fail":
      return "var(--error)";
    default:
      return "var(--text-secondary)";
  }
}

function circuitColor(state: CircuitState): string {
  switch (state) {
    case "closed":
      return "var(--success)";
    case "half_open":
      return "var(--warning)";
    case "open":
      return "var(--error)";
  }
}

function circuitLabel(state: CircuitState): string {
  switch (state) {
    case "closed":
      return "Closed";
    case "half_open":
      return "Half Open";
    case "open":
      return "Open";
  }
}

function gpuStatusColor(status: GpuWorkerInfo["status"]): string {
  switch (status) {
    case "online":
      return "var(--success)";
    case "degraded":
      return "var(--warning)";
    case "offline":
      return "var(--error)";
  }
}

function formatUptime(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.join(" ");
}

function formatTimestamp(ts: number): string {
  if (!ts) return "--";
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

const tokenChartSeries = $derived.by(() => {
  const data = $tokenUsage;
  if (data.length === 0) return [];
  return [
    {
      label: "Input Tokens",
      color: "var(--accent)",
      data: data.map((p) => ({ timestamp: p.timestamp, value: p.inputTokens })),
    },
    {
      label: "Output Tokens",
      color: "var(--success)",
      data: data.map((p) => ({ timestamp: p.timestamp, value: p.outputTokens })),
    },
  ];
});

const costChartSeries = $derived.by(() => {
  const data = $tokenUsage;
  if (data.length === 0) return [];
  return [
    {
      label: "Cost (USD)",
      color: "var(--warning)",
      data: data.map((p) => ({ timestamp: p.timestamp, value: p.costUsd })),
    },
  ];
});

onMount(() => {
  startHealthRefresh();
});

onDestroy(() => {
  stopHealthRefresh();
});
</script>

<div class="health-page">
  <header class="page-header">
    <div class="header-left">
      <h2>System Health</h2>
      <span
        class="status-indicator"
        style="background: {statusColor($overallStatus)}"
        aria-hidden="true"
      ></span>
      <span class="status-text">Status: {$overallStatus}</span>
    </div>
    <div class="header-meta">
      <span class="uptime-label">Uptime</span>
      <span class="uptime-value">{formatUptime($healthData.uptimeMs)}</span>
    </div>
  </header>

  {#if $healthError}
    <div class="error-banner" role="alert">{$healthError}</div>
  {/if}

  {#if !$isConnected}
    <div class="empty-state">
      <p>Connect to the gateway to view system health.</p>
    </div>
  {:else}
    <div class="health-content">
      <!-- Overview Cards -->
      <section class="overview-cards">
        <div class="stat-card">
          <div class="stat-header">Error Rate</div>
          <div class="stat-value" style="color: {$errorRate > 0.05 ? 'var(--error)' : $errorRate > 0.01 ? 'var(--warning)' : 'var(--success)'}">
            {($errorRate * 100).toFixed(1)}%
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-header">Event Queue</div>
          <div class="stat-value" style="color: {$eventQueueDepth > 500 ? 'var(--error)' : $eventQueueDepth > 100 ? 'var(--warning)' : 'var(--text-primary)'}">
            {$eventQueueDepth}
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-header">Total Memories</div>
          <div class="stat-value">{$memoryStats.totalMemories.toLocaleString()}</div>
        </div>
        <div class="stat-card">
          <div class="stat-header">Recent Extractions</div>
          <div class="stat-value">{$memoryStats.recentExtractions}</div>
        </div>
      </section>

      <!-- Health Checks -->
      {#if $healthData.checks.length > 0}
        <section class="section">
          <h3 class="section-title">Health Checks</h3>
          <div class="checks-grid">
            {#each $healthData.checks as check}
              <div class="check-item">
                <span
                  class="check-dot"
                  style="background: {statusColor(check.status)}"
                  aria-hidden="true"
                ></span>
                <span class="check-name">{check.name} ({check.status})</span>
                {#if check.message}
                  <span class="check-message">{check.message}</span>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Circuit Breakers -->
      {#if $circuitBreakers.length > 0}
        <section class="section">
          <h3 class="section-title">Circuit Breakers</h3>
          <div class="breakers-grid">
            {#each $circuitBreakers as cb}
              <div class="breaker-card">
                <div class="breaker-header">
                  <span class="breaker-name">{cb.name}</span>
                  <span
                    class="breaker-state"
                    style="color: {circuitColor(cb.state)}; border-color: {circuitColor(cb.state)}"
                  >
                    {circuitLabel(cb.state)}
                  </span>
                </div>
                <div class="breaker-details">
                  <span>Failures: {cb.failures}</span>
                  {#if cb.lastFailureAt}
                    <span>Last failure: {formatTimestamp(cb.lastFailureAt)}</span>
                  {/if}
                  {#if cb.lastSuccessAt}
                    <span>Last success: {formatTimestamp(cb.lastSuccessAt)}</span>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- GPU Workers -->
      {#if $gpuWorkers.length > 0}
        <section class="section">
          <h3 class="section-title">GPU Workers</h3>
          <div class="workers-grid">
            {#each $gpuWorkers as worker}
              <div class="worker-card">
                <div class="worker-header">
                  <span class="worker-name">{worker.name}</span>
                  <span
                    class="worker-status"
                    style="color: {gpuStatusColor(worker.status)}"
                  >
                    {worker.status}
                  </span>
                </div>
                <div class="worker-host">{worker.host}</div>
                {#if worker.capabilities.length > 0}
                  <div class="worker-caps">
                    {#each worker.capabilities as cap}
                      <span class="cap-badge">{cap}</span>
                    {/each}
                  </div>
                {/if}
                {#if worker.gpuUtil !== undefined || worker.vramUsed !== undefined}
                  <div class="worker-stats">
                    {#if worker.gpuUtil !== undefined}
                      <div class="gpu-stat">
                        <span class="gpu-stat-label" id="gpu-label-{worker.name}">GPU</span>
                        <div class="bar-track" role="progressbar" aria-valuenow={worker.gpuUtil} aria-valuemin={0} aria-valuemax={100} aria-labelledby="gpu-label-{worker.name}">
                          <div
                            class="bar-fill"
                            style="width: {worker.gpuUtil}%; background: {worker.gpuUtil > 90 ? 'var(--error)' : worker.gpuUtil > 70 ? 'var(--warning)' : 'var(--success)'}"
                          ></div>
                        </div>
                        <span class="gpu-stat-value">{worker.gpuUtil}%</span>
                      </div>
                    {/if}
                    {#if worker.vramUsed !== undefined && worker.vramTotal !== undefined}
                      <div class="gpu-stat">
                        <span class="gpu-stat-label" id="vram-label-{worker.name}">VRAM</span>
                        <div class="bar-track" role="progressbar" aria-valuenow={worker.vramUsed} aria-valuemin={0} aria-valuemax={worker.vramTotal} aria-labelledby="vram-label-{worker.name}">
                          <div
                            class="bar-fill"
                            style="width: {(worker.vramUsed / worker.vramTotal) * 100}%; background: var(--accent)"
                          ></div>
                        </div>
                        <span class="gpu-stat-value">{worker.vramUsed}/{worker.vramTotal} GB</span>
                      </div>
                    {/if}
                    {#if worker.temperature !== undefined}
                      <div class="gpu-stat">
                        <span class="gpu-stat-label">Temp</span>
                        <span class="gpu-stat-value" style="color: {worker.temperature > 85 ? 'var(--error)' : worker.temperature > 70 ? 'var(--warning)' : 'var(--text-primary)'}">
                          {worker.temperature} C
                        </span>
                      </div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </section>
      {/if}

      <!-- Token Usage Charts -->
      <section class="section charts-section">
        <h3 class="section-title">Token Usage</h3>
        <div class="charts-grid">
          <MetricsChart
            series={tokenChartSeries}
            title="Tokens Over Time"
            yLabel="Tokens"
            height={220}
          />
          <MetricsChart
            series={costChartSeries}
            title="Cost Over Time"
            yLabel="USD"
            height={220}
            formatValue={(v) => `$${v.toFixed(4)}`}
          />
        </div>
      </section>
    </div>
  {/if}
</div>

<style>
  .health-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .page-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }

  .header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .page-header h2 {
    font-size: 16px;
    font-weight: 600;
  }

  .status-indicator {
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }

  .status-text {
    font-size: 13px;
    color: var(--text-secondary);
    text-transform: capitalize;
  }

  .header-meta {
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
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }

  .error-banner {
    padding: 8px 20px;
    background: rgba(231, 76, 60, 0.15);
    color: var(--error);
    font-size: 13px;
  }

  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
    font-size: 14px;
  }

  .health-content {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  /* Overview Cards */
  .overview-cards {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
  }

  @media (max-width: 900px) {
    .overview-cards { grid-template-columns: repeat(2, 1fr); }
  }

  @media (max-width: 500px) {
    .overview-cards { grid-template-columns: 1fr; }
  }

  .stat-card {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }

  .stat-header {
    font-size: 12px;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 8px;
  }

  .stat-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--text-primary);
    font-variant-numeric: tabular-nums;
  }

  /* Sections */
  .section {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }

  .section-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 12px;
  }

  /* Health Checks */
  .checks-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .check-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 13px;
  }

  .check-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .check-name {
    color: var(--text-primary);
    font-weight: 500;
  }

  .check-message {
    color: var(--text-secondary);
    font-size: 12px;
    margin-left: auto;
  }

  /* Circuit Breakers */
  .breakers-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 10px;
  }

  .breaker-card {
    padding: 10px 12px;
    background: var(--bg-primary);
    border-radius: var(--radius);
  }

  .breaker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
  }

  .breaker-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .breaker-state {
    font-size: 11px;
    padding: 1px 6px;
    border: 1px solid;
    border-radius: var(--radius);
    font-weight: 600;
  }

  .breaker-details {
    display: flex;
    flex-direction: column;
    gap: 2px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  /* GPU Workers */
  .workers-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 10px;
  }

  .worker-card {
    padding: 12px 14px;
    background: var(--bg-primary);
    border-radius: var(--radius);
  }

  .worker-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
  }

  .worker-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .worker-status {
    font-size: 12px;
    font-weight: 600;
    text-transform: capitalize;
  }

  .worker-host {
    font-size: 12px;
    color: var(--text-secondary);
    margin-bottom: 6px;
  }

  .worker-caps {
    display: flex;
    gap: 4px;
    margin-bottom: 8px;
  }

  .cap-badge {
    font-size: 11px;
    padding: 1px 6px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: 3px;
  }

  .worker-stats {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .gpu-stat {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .gpu-stat-label {
    color: var(--text-secondary);
    min-width: 40px;
  }

  .bar-track {
    flex: 1;
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }

  .bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.4s ease;
  }

  .gpu-stat-value {
    font-variant-numeric: tabular-nums;
    min-width: 60px;
    text-align: right;
    color: var(--text-primary);
  }

  /* Charts */
  .charts-section {
    background: none;
    border: none;
    padding: 0;
  }

  .charts-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 14px;
  }

  @media (max-width: 900px) {
    .charts-grid { grid-template-columns: 1fr; }
  }
</style>
