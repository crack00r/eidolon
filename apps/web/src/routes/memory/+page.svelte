<script lang="ts">
  import {
    memoryResults,
    memoryQuery,
    isSearching,
    memoryError,
    selectedMemory,
    searchMemory,
    selectMemoryItem,
    clearSearch,
    type MemoryItem,
  } from "$lib/stores/memory";
  import { isConnected } from "$lib/stores/connection";

  let searchInput = $state("");
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function handleInput(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      searchMemory(searchInput);
    }, 300);
  }

  function handleClear(): void {
    searchInput = "";
    clearSearch();
  }

  function typeLabel(type: MemoryItem["type"]): string {
    const labels: Record<MemoryItem["type"], string> = {
      episodic: "Episodic",
      semantic: "Semantic",
      procedural: "Procedural",
      working: "Working",
      meta: "Meta",
    };
    return labels[type];
  }

  function typeColor(type: MemoryItem["type"]): string {
    const colors: Record<MemoryItem["type"], string> = {
      episodic: "var(--accent)",
      semantic: "var(--success)",
      procedural: "var(--warning)",
      working: "#3498db",
      meta: "#9b59b6",
    };
    return colors[type];
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

  function importanceBar(score: number): string {
    const pct = Math.round(score * 100);
    return `${pct}%`;
  }
</script>

<div class="memory-page">
  <header class="memory-header">
    <h2>Memory Browser</h2>
  </header>

  <div class="search-bar">
    <input
      type="text"
      class="search-input"
      placeholder={$isConnected ? "Search memories..." : "Connect to gateway first"}
      bind:value={searchInput}
      oninput={handleInput}
      disabled={!$isConnected}
    />
    {#if searchInput}
      <button class="clear-btn" onclick={handleClear}>Clear</button>
    {/if}
    {#if $isSearching}
      <span class="searching-indicator">Searching...</span>
    {/if}
  </div>

  {#if $memoryError}
    <div class="error-banner">{$memoryError}</div>
  {/if}

  <div class="memory-content">
    <div class="results-list">
      {#if $memoryResults.length === 0 && $memoryQuery && !$isSearching}
        <div class="no-results">No memories found for "{$memoryQuery}"</div>
      {:else if $memoryResults.length === 0 && !$memoryQuery}
        <div class="no-results">Enter a search query to browse memories.</div>
      {:else}
        {#each $memoryResults as item (item.id)}
          <button
            class="memory-item"
            class:selected={$selectedMemory?.id === item.id}
            onclick={() => selectMemoryItem(item)}
          >
            <div class="item-header">
              <span class="type-badge" style="color: {typeColor(item.type)}">
                {typeLabel(item.type)}
              </span>
              <span class="importance">{importanceBar(item.importance)}</span>
            </div>
            <div class="item-preview">
              {item.content.length > 120 ? item.content.slice(0, 120) + "..." : item.content}
            </div>
            <div class="item-date">{formatDate(item.createdAt)}</div>
          </button>
        {/each}
      {/if}
    </div>

    {#if $selectedMemory}
      <div class="detail-panel">
        <div class="detail-header">
          <span class="type-badge" style="color: {typeColor($selectedMemory.type)}">
            {typeLabel($selectedMemory.type)}
          </span>
          <button class="close-detail" onclick={() => selectMemoryItem(null)}>Close</button>
        </div>
        <div class="detail-meta">
          <div class="meta-row">
            <span class="meta-label">Importance</span>
            <div class="importance-bar-container">
              <div
                class="importance-bar-fill"
                style="width: {$selectedMemory.importance * 100}%"
              ></div>
            </div>
            <span class="meta-value">{importanceBar($selectedMemory.importance)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">Created</span>
            <span class="meta-value">{formatDate($selectedMemory.createdAt)}</span>
          </div>
          <div class="meta-row">
            <span class="meta-label">ID</span>
            <span class="meta-value mono">{$selectedMemory.id}</span>
          </div>
        </div>
        <div class="detail-content">
          {$selectedMemory.content}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .memory-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .memory-header {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }

  .memory-header h2 {
    font-size: 16px;
    font-weight: 600;
  }

  .search-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }

  .search-input {
    flex: 1;
  }

  .clear-btn {
    padding: 6px 12px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: var(--radius);
    font-size: 12px;
  }

  .clear-btn:hover {
    color: var(--text-primary);
  }

  .searching-indicator {
    font-size: 12px;
    color: var(--warning);
  }

  .error-banner {
    padding: 8px 20px;
    background: rgba(231, 76, 60, 0.15);
    color: var(--error);
    font-size: 13px;
  }

  .memory-content {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .results-list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
  }

  .no-results {
    padding: 40px 20px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 14px;
  }

  .memory-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 10px 12px;
    border-radius: var(--radius);
    background: none;
    color: var(--text-primary);
    margin-bottom: 2px;
    transition: background-color 0.1s;
  }

  .memory-item:hover {
    background: var(--bg-tertiary);
  }

  .memory-item.selected {
    background: var(--bg-tertiary);
    border-left: 2px solid var(--accent);
  }

  .item-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .type-badge {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }

  .importance {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .item-preview {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.4;
    margin-bottom: 4px;
  }

  .item-date {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .detail-panel {
    width: 360px;
    min-width: 360px;
    border-left: 1px solid var(--border);
    overflow-y: auto;
    padding: 16px;
    background: var(--bg-secondary);
  }

  .detail-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .close-detail {
    padding: 4px 10px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: var(--radius);
    font-size: 12px;
  }

  .close-detail:hover {
    color: var(--text-primary);
  }

  .detail-meta {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 16px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }

  .meta-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .meta-label {
    color: var(--text-secondary);
    min-width: 80px;
  }

  .meta-value {
    color: var(--text-primary);
  }

  .meta-value.mono {
    font-size: 11px;
    word-break: break-all;
  }

  .importance-bar-container {
    flex: 1;
    height: 4px;
    background: var(--bg-primary);
    border-radius: 2px;
    overflow: hidden;
  }

  .importance-bar-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 2px;
    transition: width 0.2s;
  }

  .detail-content {
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
  }
</style>
