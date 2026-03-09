<script lang="ts">
import {
  activeConversationId,
  conversations,
  createConversation,
  deleteConversation,
  switchConversation,
} from "../stores/conversations";
import { loadPersistedMessages } from "../stores/chat";

let confirmDeleteId = $state<string | null>(null);

function handleNew(): void {
  createConversation();
  loadPersistedMessages();
}

function handleSwitch(id: string): void {
  switchConversation(id);
  loadPersistedMessages();
}

function handleDelete(id: string, event: MouseEvent): void {
  event.stopPropagation();
  if (confirmDeleteId === id) {
    deleteConversation(id);
    loadPersistedMessages();
    confirmDeleteId = null;
  } else {
    confirmDeleteId = id;
    // Auto-dismiss confirmation after 3 seconds
    setTimeout(() => {
      confirmDeleteId = null;
    }, 3000);
  }
}

function formatDate(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const ONE_DAY = 86_400_000;
  const ONE_HOUR = 3_600_000;
  const ONE_MINUTE = 60_000;

  if (diff < ONE_MINUTE) return "just now";
  if (diff < ONE_HOUR) return `${Math.floor(diff / ONE_MINUTE)}m ago`;
  if (diff < ONE_DAY) return `${Math.floor(diff / ONE_HOUR)}h ago`;
  if (diff < ONE_DAY * 7) return `${Math.floor(diff / ONE_DAY)}d ago`;
  return new Date(timestamp).toLocaleDateString([], { month: "short", day: "numeric" });
}
</script>

<div class="conversation-sidebar">
  <div class="sidebar-top">
    <span class="sidebar-title">Conversations</span>
    <button class="new-conv-btn" onclick={handleNew} aria-label="New conversation">
      + New
    </button>
  </div>

  <div class="conv-list" role="listbox" aria-label="Conversation list">
    {#if $conversations.length === 0}
      <div class="conv-empty">
        <p>No conversations yet.</p>
        <p>Start one by sending a message.</p>
      </div>
    {:else}
      {#each $conversations as conv (conv.id)}
        <!-- Using <div> with role="option" to avoid nested <button> elements -->
        <div
          class="conv-item"
          class:active={$activeConversationId === conv.id}
          role="option"
          tabindex="0"
          aria-selected={$activeConversationId === conv.id}
          onclick={() => handleSwitch(conv.id)}
          onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSwitch(conv.id); } }}
        >
          <div class="conv-header">
            <span class="conv-title">{conv.title}</span>
            <button
              class="conv-delete"
              class:confirm={confirmDeleteId === conv.id}
              onclick={(e) => handleDelete(conv.id, e)}
              aria-label={confirmDeleteId === conv.id ? "Confirm delete" : "Delete conversation"}
            >
              {confirmDeleteId === conv.id ? "?" : "x"}
            </button>
          </div>
          {#if conv.preview}
            <div class="conv-preview">{conv.preview}</div>
          {/if}
          <div class="conv-meta">
            <span>{formatDate(conv.updatedAt)}</span>
            <span>{conv.messageCount} msg{conv.messageCount !== 1 ? "s" : ""}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .conversation-sidebar {
    width: 260px;
    min-width: 260px;
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--bg-primary);
    overflow: hidden;
  }

  .sidebar-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
  }

  .sidebar-title {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .new-conv-btn {
    padding: 4px 10px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius);
    font-size: 11px;
    font-weight: 600;
    transition: background-color 0.15s;
  }

  .new-conv-btn:hover {
    background: var(--accent-hover);
  }

  .conv-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px;
  }

  .conv-empty {
    padding: 20px 12px;
    text-align: center;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.5;
  }

  .conv-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 10px;
    border-radius: var(--radius);
    background: none;
    color: var(--text-primary);
    margin-bottom: 2px;
    transition: background-color 0.1s;
    position: relative;
    cursor: pointer;
    user-select: none;
  }

  .conv-item:hover {
    background: var(--bg-tertiary);
  }

  .conv-item.active {
    background: var(--bg-tertiary);
    border-left: 2px solid var(--accent);
    padding-left: 8px;
  }

  .conv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 4px;
    margin-bottom: 2px;
  }

  .conv-title {
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .conv-delete {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    color: var(--text-secondary);
    border-radius: 3px;
    font-size: 11px;
    opacity: 0;
    transition: opacity 0.1s, background-color 0.1s, color 0.1s;
    flex-shrink: 0;
  }

  .conv-item:hover .conv-delete {
    opacity: 1;
  }

  .conv-delete:hover {
    background: var(--error);
    color: white;
  }

  .conv-delete.confirm {
    opacity: 1;
    background: var(--error);
    color: white;
  }

  .conv-preview {
    font-size: 11px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-bottom: 2px;
  }

  .conv-meta {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--text-secondary);
    opacity: 0.7;
  }
</style>
