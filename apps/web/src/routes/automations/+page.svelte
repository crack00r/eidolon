<script lang="ts">
import { onMount } from "svelte";
import { clientLog } from "$lib/logger";
import { isConnected } from "$lib/stores/connection";
import {
  automationScenes,
  createScene,
  deleteScene,
  executeScene,
  fetchScenes,
  isLoadingAutomations,
  automationError,
} from "$lib/stores/automations";

let showCreateForm = $state(false);
let newSceneInput = $state("");
let newSceneDeliverTo = $state("");
let isCreating = $state(false);
let isExecuting: Record<string, boolean> = $state({});

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function handleRefresh(): Promise<void> {
  try {
    await fetchScenes();
  } catch (err) {
    clientLog("error", "automations-page", "handleRefresh failed", err);
  }
}

async function handleCreate(): Promise<void> {
  if (!newSceneInput.trim()) return;
  isCreating = true;
  try {
    await createScene(
      newSceneInput.trim(),
      newSceneDeliverTo.trim() || undefined,
    );
    newSceneInput = "";
    newSceneDeliverTo = "";
    showCreateForm = false;
  } catch (err) {
    clientLog("error", "automations-page", "handleCreate failed", err);
  } finally {
    isCreating = false;
  }
}

async function handleExecute(id: string): Promise<void> {
  isExecuting = { ...isExecuting, [id]: true };
  try {
    await executeScene(id);
  } catch (err) {
    clientLog("error", "automations-page", "handleExecute failed", err);
  } finally {
    isExecuting = { ...isExecuting, [id]: false };
  }
}

async function handleDelete(id: string): Promise<void> {
  try {
    await deleteScene(id);
  } catch (err) {
    clientLog("error", "automations-page", "handleDelete failed", err);
  }
}

onMount(() => {
  if ($isConnected) {
    fetchScenes();
  }
});
</script>

<div class="automations-page">
  <header class="page-header">
    <div class="header-left">
      <h2>Automations</h2>
      <span class="scene-count">{$automationScenes.length} scenes</span>
    </div>
    <div class="header-controls">
      <button
        class="create-btn"
        onclick={() => (showCreateForm = !showCreateForm)}
        disabled={!$isConnected}
        aria-expanded={showCreateForm}
      >
        {showCreateForm ? "Cancel" : "New Scene"}
      </button>
      <button
        class="refresh-btn"
        onclick={handleRefresh}
        disabled={!$isConnected || $isLoadingAutomations}
      >
        {$isLoadingAutomations ? "Loading..." : "Refresh"}
      </button>
    </div>
  </header>

  {#if $automationError}
    <div class="error-banner" role="alert">{$automationError}</div>
  {/if}

  {#if showCreateForm}
    <div class="create-form">
      <div class="form-field">
        <label for="scene-input">Scene description</label>
        <textarea
          id="scene-input"
          class="form-textarea"
          bind:value={newSceneInput}
          placeholder="Describe the automation scene (e.g., 'Turn off all lights in the living room')"
          rows="3"
        ></textarea>
      </div>
      <div class="form-field">
        <label for="deliver-to">Deliver to (optional)</label>
        <input
          id="deliver-to"
          class="form-input"
          bind:value={newSceneDeliverTo}
          placeholder="Channel or device to deliver results"
        />
      </div>
      <button
        class="submit-btn"
        onclick={handleCreate}
        disabled={!newSceneInput.trim() || isCreating}
      >
        {isCreating ? "Creating..." : "Create Scene"}
      </button>
    </div>
  {/if}

  <div class="scenes-list">
    {#if !$isConnected}
      <div class="empty-state">
        <p>Connect to the gateway to manage automations.</p>
      </div>
    {:else if $automationScenes.length === 0 && !$isLoadingAutomations}
      <div class="empty-state">
        <p class="empty-title">No automation scenes</p>
        <p>Create a new scene to automate Home Assistant actions.</p>
      </div>
    {:else}
      {#each $automationScenes as scene (scene.id)}
        <div class="scene-item" class:disabled={!scene.enabled}>
          <div class="scene-top">
            <div class="scene-title-row">
              <h3 class="scene-name">{scene.name}</h3>
              <span class="scene-status" class:enabled={scene.enabled}>
                {scene.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
            <p class="scene-description">{scene.description}</p>
          </div>

          <div class="scene-meta">
            {#if scene.schedule}
              <span class="meta-item">
                Schedule: <strong>{scene.schedule}</strong>
              </span>
            {/if}
            {#if scene.lastExecutedAt}
              <span class="meta-item">
                Last run: <strong>{formatDate(scene.lastExecutedAt)}</strong>
              </span>
            {/if}
            <span class="meta-item">
              Created: {formatDate(scene.createdAt)}
            </span>
          </div>

          <div class="scene-actions">
            <button
              class="execute-btn"
              onclick={() => handleExecute(scene.id)}
              disabled={!scene.enabled || isExecuting[scene.id]}
            >
              {isExecuting[scene.id] ? "Running..." : "Execute"}
            </button>
            <button
              class="delete-btn"
              onclick={() => handleDelete(scene.id)}
              aria-label="Delete scene: {scene.name}"
            >
              Delete
            </button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .automations-page {
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

  .scene-count {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .header-controls {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .create-btn {
    padding: 6px 14px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
  }

  .create-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .create-btn:disabled {
    opacity: 0.4;
    cursor: default;
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

  /* Create form */
  .create-form {
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .form-field label {
    font-size: 12px;
    color: var(--text-secondary);
    font-weight: 500;
  }

  .form-textarea {
    padding: 8px 10px;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
    resize: vertical;
    font-family: inherit;
  }

  .form-input {
    padding: 8px 10px;
    background: var(--bg-primary);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 13px;
  }

  .submit-btn {
    align-self: flex-start;
    padding: 8px 20px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
  }

  .submit-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .submit-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /* Scene list */
  .scenes-list {
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

  .scene-item {
    padding: 14px 16px;
    border-radius: var(--radius);
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    transition: opacity 0.2s;
  }

  .scene-item.disabled {
    opacity: 0.5;
  }

  .scene-top {
    margin-bottom: 10px;
  }

  .scene-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 6px;
  }

  .scene-name {
    font-size: 14px;
    font-weight: 600;
  }

  .scene-status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: var(--radius);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-weight: 600;
  }

  .scene-status.enabled {
    color: var(--success);
  }

  .scene-description {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.4;
  }

  .scene-meta {
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

  .scene-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .execute-btn {
    padding: 6px 16px;
    background: var(--success);
    color: white;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
  }

  .execute-btn:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .execute-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .delete-btn {
    padding: 6px 16px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
  }

  .delete-btn:hover {
    color: var(--error);
  }
</style>
