<script lang="ts">
import { onDestroy } from "svelte";
import { isConnected } from "../../lib/stores/connection";
import {
  clearSearch,
  deleteMemory,
  editMemory,
  isDeleting,
  isEditing,
  isSearching,
  type MemoryItem,
  memoryError,
  memoryQuery,
  memoryResults,
  searchMemory,
  selectedMemory,
  selectMemoryItem,
} from "../../lib/stores/memory";

let searchInput = $state("");
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let showDeleteConfirm = $state(false);
let deleteTargetId = $state<string | null>(null);
let editMode = $state(false);
let editContent = $state("");
let editImportance = $state(0);
let modalCancelRef: HTMLButtonElement | undefined = $state();

function handleModalKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    cancelDelete();
  }
}

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

function startEdit(item: MemoryItem): void {
  editMode = true;
  editContent = item.content;
  editImportance = item.importance;
}

function cancelEdit(): void {
  editMode = false;
  editContent = "";
  editImportance = 0;
}

async function saveEdit(): Promise<void> {
  const item = $selectedMemory;
  if (!item) return;
  const success = await editMemory(item.id, {
    content: editContent,
    importance: editImportance,
  });
  if (success) {
    editMode = false;
  }
}

function confirmDelete(id: string): void {
  deleteTargetId = id;
  showDeleteConfirm = true;
}

async function executeDelete(): Promise<void> {
  if (!deleteTargetId) return;
  await deleteMemory(deleteTargetId);
  showDeleteConfirm = false;
  deleteTargetId = null;
}

function cancelDelete(): void {
  showDeleteConfirm = false;
  deleteTargetId = null;
}

$effect(() => {
  if (showDeleteConfirm && modalCancelRef) {
    modalCancelRef.focus();
  }
});

onDestroy(() => {
  if (debounceTimer) clearTimeout(debounceTimer);
});
</script>

<div class="memory-page">
  <header class="memory-header">
    <h2>Memory Browser</h2>
  </header>

  <div class="search-bar" role="search">
    <input
      type="text"
      class="search-input"
      placeholder={$isConnected ? "Search memories..." : "Connect to gateway first"}
      aria-label="Search memories"
      bind:value={searchInput}
      oninput={handleInput}
      disabled={!$isConnected}
    />
    {#if searchInput}
      <button class="clear-btn" onclick={handleClear} aria-label="Clear search">Clear</button>
    {/if}
    {#if $isSearching}
      <span class="searching-indicator" role="status" aria-live="polite">Searching...</span>
    {/if}
  </div>

  {#if $memoryError}
    <div class="error-banner" role="alert">{$memoryError}</div>
  {/if}

  <div class="memory-content">
    <div class="results-list" role="listbox" aria-label="Memory search results">
      {#if $memoryResults.length === 0 && $memoryQuery && !$isSearching}
        <div class="no-results">No memories found for "{$memoryQuery}"</div>
      {:else if $memoryResults.length === 0 && !$memoryQuery}
        <div class="no-results">Enter a search query to browse memories.</div>
      {:else}
        {#each $memoryResults as item (item.id)}
          <button
            class="memory-item"
            class:selected={$selectedMemory?.id === item.id}
            role="option"
            aria-selected={$selectedMemory?.id === item.id}
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
      <div class="detail-panel" role="region" aria-label="Memory detail">
        <div class="detail-header">
          <span class="type-badge" style="color: {typeColor($selectedMemory.type)}">
            {typeLabel($selectedMemory.type)}
          </span>
          <button class="close-detail" onclick={() => { selectMemoryItem(null); cancelEdit(); }} aria-label="Close detail panel">Close</button>
        </div>
        <div class="detail-meta">
          <div class="meta-row">
            <span class="meta-label">Importance</span>
            <div class="importance-bar-container" role="progressbar" aria-label="Importance" aria-valuenow={Math.round($selectedMemory.importance * 100)} aria-valuemin={0} aria-valuemax={100}>
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

        {#if editMode}
          <div class="edit-form">
            <label class="edit-label" for="edit-content">Content</label>
            <textarea id="edit-content" class="edit-textarea" bind:value={editContent} rows="6"></textarea>
            <label class="edit-label" for="edit-importance">Importance ({Math.round(editImportance * 100)}%)</label>
            <input id="edit-importance" type="range" min="0" max="1" step="0.01" bind:value={editImportance} class="edit-slider" />
            <div class="edit-actions">
              <button class="action-btn save-btn" onclick={saveEdit} disabled={$isEditing}>
                {$isEditing ? "Saving..." : "Save"}
              </button>
              <button class="action-btn cancel-btn" onclick={cancelEdit}>Cancel</button>
            </div>
          </div>
        {:else}
          <div class="detail-content">
            {$selectedMemory.content}
          </div>
          <div class="detail-actions">
            <button class="action-btn edit-btn" onclick={() => startEdit($selectedMemory)}>Edit</button>
            <button
              class="action-btn delete-btn"
              onclick={() => confirmDelete($selectedMemory.id)}
              disabled={$isDeleting}
            >
              {$isDeleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        {/if}
      </div>
    {/if}

    {#if showDeleteConfirm}
      <div class="modal-overlay" onclick={cancelDelete} onkeydown={handleModalKeydown} role="presentation">
        <div
          class="modal-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-modal-title"
          aria-describedby="delete-modal-message"
          tabindex="-1"
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => e.stopPropagation()}
        >
          <h3 class="modal-title" id="delete-modal-title">Delete Memory</h3>
          <p class="modal-message" id="delete-modal-message">Are you sure you want to permanently delete this memory? This action cannot be undone.</p>
          <div class="modal-actions">
            <button class="action-btn delete-btn" onclick={executeDelete} disabled={$isDeleting}>
              {$isDeleting ? "Deleting..." : "Delete"}
            </button>
            <button class="action-btn cancel-btn" onclick={cancelDelete} bind:this={modalCancelRef}>Cancel</button>
          </div>
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

  .detail-actions {
    display: flex;
    gap: 8px;
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
  }

  .action-btn {
    padding: 6px 14px;
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 600;
    transition: background-color 0.15s, opacity 0.15s;
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .edit-btn {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .edit-btn:hover:not(:disabled) {
    background: var(--accent);
    color: #fff;
  }

  .delete-btn {
    background: rgba(231, 76, 60, 0.15);
    color: var(--error);
  }

  .delete-btn:hover:not(:disabled) {
    background: var(--error);
    color: #fff;
  }

  .save-btn {
    background: var(--accent);
    color: #fff;
  }

  .save-btn:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .cancel-btn {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
  }

  .cancel-btn:hover {
    color: var(--text-primary);
  }

  .edit-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .edit-label {
    font-size: 11px;
    color: var(--text-secondary);
    font-weight: 600;
    text-transform: uppercase;
  }

  .edit-textarea {
    width: 100%;
    resize: vertical;
    min-height: 80px;
    font-size: 13px;
    line-height: 1.5;
  }

  .edit-slider {
    width: 100%;
    accent-color: var(--accent);
  }

  .edit-actions {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal-dialog {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
    max-width: 400px;
    width: 90%;
  }

  .modal-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 8px;
  }

  .modal-message {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 16px;
  }

  .modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
