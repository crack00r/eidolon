<script lang="ts">
import { onMount } from "svelte";
import { clientLog } from "$lib/logger";
import { isConnected } from "$lib/stores/connection";
import {
  approvalItems,
  approveItem,
  fetchApprovals,
  isLoadingApprovals,
  approvalError,
  pendingApprovalCount,
  rejectItem,
  type ApprovalLevel,
} from "$lib/stores/approvals";
import ApprovalCard from "$lib/components/ApprovalCard.svelte";

type FilterStatus = "all" | "pending" | "approved" | "denied";
type SortField = "createdAt" | "level" | "action";

let filterStatus: FilterStatus = $state("all");
let sortField: SortField = $state("createdAt");

const filteredItems = $derived.by(() => {
  let items = $approvalItems;

  if (filterStatus !== "all") {
    items = items.filter((i) => i.status === filterStatus);
  }

  return [...items].sort((a, b) => {
    if (sortField === "createdAt") return b.createdAt - a.createdAt;
    if (sortField === "action") return a.action.localeCompare(b.action);
    // Sort by level: dangerous > needs_approval > safe
    const levelOrder: Record<ApprovalLevel, number> = {
      dangerous: 0,
      needs_approval: 1,
      safe: 2,
    };
    return levelOrder[a.level] - levelOrder[b.level];
  });
});

async function handleApprove(id: string): Promise<void> {
  try {
    await approveItem(id);
  } catch (err) {
    clientLog("error", "approvals-page", "handleApprove failed", err);
  }
}

async function handleReject(id: string): Promise<void> {
  try {
    await rejectItem(id);
  } catch (err) {
    clientLog("error", "approvals-page", "handleReject failed", err);
  }
}

async function handleRefresh(): Promise<void> {
  try {
    await fetchApprovals();
  } catch (err) {
    clientLog("error", "approvals-page", "handleRefresh failed", err);
  }
}

onMount(() => {
  if ($isConnected) {
    fetchApprovals();
  }
});
</script>

<div class="approvals-page">
  <header class="page-header">
    <div class="header-left">
      <h2>Approvals</h2>
      {#if $pendingApprovalCount > 0}
        <span class="pending-badge">{$pendingApprovalCount} pending</span>
      {/if}
    </div>
    <div class="header-controls">
      <select class="filter-select" bind:value={filterStatus}>
        <option value="all">All</option>
        <option value="pending">Pending</option>
        <option value="approved">Approved</option>
        <option value="denied">Denied</option>
      </select>
      <select class="filter-select" bind:value={sortField}>
        <option value="createdAt">Newest</option>
        <option value="level">Risk Level</option>
        <option value="action">Action</option>
      </select>
      <button
        class="refresh-btn"
        onclick={handleRefresh}
        disabled={!$isConnected || $isLoadingApprovals}
      >
        {$isLoadingApprovals ? "Loading..." : "Refresh"}
      </button>
    </div>
  </header>

  {#if $approvalError}
    <div class="error-banner">{$approvalError}</div>
  {/if}

  <div class="items-list">
    {#if !$isConnected}
      <div class="empty-state">
        <p>Connect to the gateway to view approval requests.</p>
      </div>
    {:else if filteredItems.length === 0 && !$isLoadingApprovals}
      <div class="empty-state">
        <p class="empty-title">No approval requests</p>
        <p>
          {#if filterStatus !== "all"}
            No {filterStatus} approvals found. Try changing the filter.
          {:else}
            No pending approvals. Eidolon will request approval when needed.
          {/if}
        </p>
      </div>
    {:else}
      {#each filteredItems as item (item.id)}
        <ApprovalCard {item} onApprove={handleApprove} onReject={handleReject} />
      {/each}
    {/if}
  </div>
</div>

<style>
  .approvals-page {
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
    flex-wrap: wrap;
    gap: 8px;
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

  .pending-badge {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--accent);
    color: white;
    font-weight: 600;
  }

  .header-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .filter-select {
    padding: 6px 10px;
    background: var(--bg-tertiary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
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
</style>
