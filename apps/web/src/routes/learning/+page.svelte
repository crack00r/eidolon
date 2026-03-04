<script lang="ts">
import { clientLog } from "$lib/logger";
import { isConnected } from "$lib/stores/connection";
import {
  approveItem,
  fetchPendingItems,
  isLoadingLearning,
  learningError,
  learningItems,
  pendingCount,
  rejectItem,
  type SafetyClassification,
} from "$lib/stores/learning";

function safetyColor(safety: SafetyClassification): string {
  const colors: Record<SafetyClassification, string> = {
    safe: "var(--success)",
    review: "var(--warning)",
    unsafe: "var(--error)",
  };
  return colors[safety];
}

function safetyLabel(safety: SafetyClassification): string {
  const labels: Record<SafetyClassification, string> = {
    safe: "Safe",
    review: "Needs Review",
    unsafe: "Unsafe",
  };
  return labels[safety];
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relevanceDisplay(score: number): string {
  return `${Math.round(score * 100)}%`;
}

async function handleApprove(id: string): Promise<void> {
  try {
    await approveItem(id);
  } catch (err) {
    console.error("Failed to approve item:", err);
  }
}

async function handleReject(id: string): Promise<void> {
  try {
    await rejectItem(id);
  } catch (err) {
    console.error("Failed to reject item:", err);
  }
}

async function handleRefresh(): Promise<void> {
  try {
    await fetchPendingItems();
  } catch (err) {
    clientLog("error", "learning-page", "handleRefresh failed", err);
  }
}
</script>

<div class="learning-page">
  <header class="learning-header">
    <div class="header-left">
      <h2>Learning Journal</h2>
      {#if $pendingCount > 0}
        <span class="pending-badge">{$pendingCount} pending</span>
      {/if}
    </div>
    <button
      class="refresh-btn"
      onclick={handleRefresh}
      disabled={!$isConnected || $isLoadingLearning}
    >
      {$isLoadingLearning ? "Loading..." : "Refresh"}
    </button>
  </header>

  {#if $learningError}
    <div class="error-banner" role="alert">{$learningError}</div>
  {/if}

  <div class="items-list">
    {#if !$isConnected}
      <div class="empty-state">
        <p>Connect to the gateway to view learning discoveries.</p>
      </div>
    {:else if $learningItems.length === 0 && !$isLoadingLearning}
      <div class="empty-state">
        <p class="empty-title">No learning discoveries</p>
        <p>Click Refresh to check for new discoveries from Eidolon.</p>
      </div>
    {:else}
      {#each $learningItems as item (item.id)}
        <div
          class="learning-item"
          class:approved={item.status === "approved"}
          class:rejected={item.status === "rejected"}
        >
          <div class="item-top">
            <div class="item-title-row">
              <h3 class="item-title">{item.title}</h3>
              <span
                class="safety-badge"
                style="color: {safetyColor(item.safety)}; border-color: {safetyColor(item.safety)}"
              >
                {safetyLabel(item.safety)}
              </span>
            </div>
            <p class="item-description">{item.description}</p>
          </div>

          <div class="item-meta">
            <span class="meta-item">
              Source: <strong>{item.source}</strong>
            </span>
            <span class="meta-item">
              Relevance: <strong>{relevanceDisplay(item.relevanceScore)}</strong>
            </span>
            <span class="meta-item">
              {formatDate(item.discoveredAt)}
            </span>
          </div>

          <div class="item-actions">
            {#if item.status === "pending"}
              <button class="approve-btn" onclick={() => handleApprove(item.id)} aria-label="Approve {item.title}">
                Approve
              </button>
              <button class="reject-btn" onclick={() => handleReject(item.id)} aria-label="Reject {item.title}">
                Reject
              </button>
            {:else}
              <span
                class="status-label"
                class:approved={item.status === "approved"}
                class:rejected={item.status === "rejected"}
              >
                {item.status === "approved" ? "Approved" : "Rejected"}
              </span>
            {/if}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .learning-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .learning-header {
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

  .learning-header h2 {
    font-size: 16px;
    font-weight: 600;
  }

  .pending-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--accent);
    color: white;
    font-weight: 600;
  }

  .refresh-btn {
    padding: 6px 14px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: var(--radius);
    font-size: 13px;
  }

  .refresh-btn:hover:not(:disabled) {
    color: var(--text-primary);
  }

  .refresh-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .error-banner {
    padding: 8px 20px;
    background: rgba(231, 76, 60, 0.15);
    color: var(--error);
    font-size: 13px;
  }

  .items-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px 20px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
    text-align: center;
  }

  .empty-title {
    font-size: 16px;
    margin-bottom: 4px;
    color: var(--text-primary);
  }

  .learning-item {
    padding: 14px 16px;
    border-radius: var(--radius);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    transition: opacity 0.2s;
  }

  .learning-item.approved {
    opacity: 0.6;
    border-left: 3px solid var(--success);
  }

  .learning-item.rejected {
    opacity: 0.6;
    border-left: 3px solid var(--error);
  }

  .item-top {
    margin-bottom: 10px;
  }

  .item-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;
  }

  .item-title {
    font-size: 14px;
    font-weight: 600;
  }

  .safety-badge {
    font-size: 11px;
    padding: 2px 8px;
    border: 1px solid;
    border-radius: var(--radius);
    font-weight: 600;
    white-space: nowrap;
  }

  .item-description {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .item-meta {
    display: flex;
    gap: 16px;
    font-size: 12px;
    color: var(--text-secondary);
    margin-bottom: 10px;
    flex-wrap: wrap;
  }

  .meta-item strong {
    color: var(--text-primary);
  }

  .item-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .approve-btn {
    padding: 6px 16px;
    background: var(--success);
    color: white;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
  }

  .approve-btn:hover {
    filter: brightness(1.1);
  }

  .reject-btn {
    padding: 6px 16px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
  }

  .reject-btn:hover {
    color: var(--error);
  }

  .status-label {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .status-label.approved {
    color: var(--success);
  }

  .status-label.rejected {
    color: var(--error);
  }
</style>
