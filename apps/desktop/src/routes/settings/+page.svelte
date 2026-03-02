<script lang="ts">
import { onMount } from "svelte";
import { getVersion } from "@tauri-apps/api/app";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { connect, connectionState, disconnect, isConnected } from "../../lib/stores/connection";
import {
  resetSettings,
  setAutoCheck,
  setLastChecked,
  settingsStore,
  updateSettings,
  updateSettingsStore,
} from "../../lib/stores/settings";

let host = $state($settingsStore.host);
let port = $state($settingsStore.port);
let token = $state($settingsStore.token);
let useTls = $state($settingsStore.useTls);
let saved = $state(false);

let appVersion = $state("...");
let updateStatus = $state<"idle" | "checking" | "available" | "downloading" | "error">("idle");
let updateError = $state<string | null>(null);
let updateVersion = $state<string | null>(null);
let downloadProgress = $state(0);

onMount(async () => {
  try {
    appVersion = await getVersion();
  } catch {
    appVersion = "unknown";
  }

  // Auto-check on startup if enabled
  if ($updateSettingsStore.autoCheck) {
    await handleCheckUpdate();
  }
});

function handleSave(): void {
  updateSettings({ host, port, token, useTls });
  saved = true;
  setTimeout(() => {
    saved = false;
  }, 2000);
}

function handleReset(): void {
  resetSettings();
  host = "127.0.0.1";
  port = 8419;
  token = "";
  useTls = true;
}

function handleConnect(): void {
  handleSave();
  connect();
}

function handleDisconnect(): void {
  disconnect();
}

async function handleCheckUpdate(): Promise<void> {
  updateStatus = "checking";
  updateError = null;
  updateVersion = null;

  try {
    const update = await check();
    setLastChecked(new Date().toISOString());

    if (update) {
      updateStatus = "available";
      updateVersion = update.version;
    } else {
      updateStatus = "idle";
    }
  } catch (err) {
    updateStatus = "error";
    updateError = err instanceof Error ? err.message : String(err);
  }
}

async function handleInstallUpdate(): Promise<void> {
  updateStatus = "downloading";
  downloadProgress = 0;

  try {
    const update = await check();
    if (!update) {
      updateStatus = "idle";
      return;
    }

    let totalLength = 0;
    let downloaded = 0;

    await update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started" && event.data.contentLength) {
        totalLength = event.data.contentLength;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (totalLength > 0) {
          downloadProgress = Math.round((downloaded / totalLength) * 100);
        }
      }
    });

    await relaunch();
  } catch (err) {
    updateStatus = "error";
    updateError = err instanceof Error ? err.message : String(err);
  }
}

function handleAutoCheckToggle(enabled: boolean): void {
  setAutoCheck(enabled);
}

function formatLastChecked(iso: string | null): string {
  if (!iso) return "Never";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "Unknown";
  }
}

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

<div class="settings-page">
  <header class="settings-header">
    <h2>Settings</h2>
  </header>

  <div class="settings-content">
    <section class="settings-section">
      <h3 class="section-title">Gateway Connection</h3>

      <div class="connection-info">
        <span
          class="status-dot"
          style="background-color: {stateColor($connectionState)}"
        ></span>
        <span class="status-text">
          Status: <strong>{$connectionState}</strong>
        </span>
      </div>

      <div class="form-group">
        <label class="form-label" for="host">Host</label>
        <input
          id="host"
          type="text"
          bind:value={host}
          placeholder="127.0.0.1"
          disabled={$isConnected}
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="port">Port</label>
        <input
          id="port"
          type="number"
          bind:value={port}
          placeholder="8419"
          min={1}
          max={65535}
          disabled={$isConnected}
        />
      </div>

      <div class="form-group">
        <label class="form-label" for="token">Auth Token</label>
        <input
          id="token"
          type="password"
          bind:value={token}
          placeholder="Optional authentication token"
          autocomplete="off"
          disabled={$isConnected}
        />
      </div>

      <div class="form-group form-group-inline">
        <input
          id="useTls"
          type="checkbox"
          bind:checked={useTls}
          disabled={$isConnected}
        />
        <label class="form-label" for="useTls">Use TLS (WSS)</label>
      </div>

      <div class="button-group">
        {#if $isConnected}
          <button class="btn btn-disconnect" onclick={handleDisconnect}>
            Disconnect
          </button>
        {:else}
          <button
            class="btn btn-connect"
            onclick={handleConnect}
            disabled={$connectionState === "connecting" || $connectionState === "authenticating"}
          >
            {$connectionState === "connecting" || $connectionState === "authenticating"
              ? "Connecting..."
              : "Connect"}
          </button>
        {/if}

        <button class="btn btn-save" onclick={handleSave} disabled={$isConnected}>
          {saved ? "Saved" : "Save"}
        </button>

        <button class="btn btn-reset" onclick={handleReset} disabled={$isConnected}>
          Reset to Defaults
        </button>
      </div>
    </section>

    <section class="settings-section">
      <h3 class="section-title">Updates</h3>

      <div class="about-info">
        <div class="about-row">
          <span class="about-label">Current Version</span>
          <span class="about-value">{appVersion}</span>
        </div>
        <div class="about-row">
          <span class="about-label">Last Checked</span>
          <span class="about-value">{formatLastChecked($updateSettingsStore.lastChecked)}</span>
        </div>
        {#if updateStatus === "available" && updateVersion}
          <div class="about-row">
            <span class="about-label">Available Version</span>
            <span class="about-value update-available">{updateVersion}</span>
          </div>
        {/if}
      </div>

      {#if updateStatus === "error" && updateError}
        <div class="update-error">
          {updateError}
        </div>
      {/if}

      {#if updateStatus === "downloading"}
        <div class="update-progress">
          <div class="progress-bar">
            <div class="progress-fill" style="width: {downloadProgress}%"></div>
          </div>
          <span class="progress-text">Downloading... {downloadProgress}%</span>
        </div>
      {/if}

      <div class="form-group form-group-inline">
        <input
          id="autoCheck"
          type="checkbox"
          checked={$updateSettingsStore.autoCheck}
          onchange={(e) => handleAutoCheckToggle(e.currentTarget.checked)}
        />
        <label class="form-label" for="autoCheck">Check for updates automatically</label>
      </div>

      <div class="button-group">
        <button
          class="btn btn-connect"
          onclick={handleCheckUpdate}
          disabled={updateStatus === "checking" || updateStatus === "downloading"}
        >
          {updateStatus === "checking" ? "Checking..." : "Check for Updates"}
        </button>

        {#if updateStatus === "available"}
          <button class="btn btn-update" onclick={handleInstallUpdate}>
            Install Update
          </button>
        {/if}
      </div>
    </section>

    <section class="settings-section">
      <h3 class="section-title">About</h3>
      <div class="about-info">
        <div class="about-row">
          <span class="about-label">Application</span>
          <span class="about-value">Eidolon Desktop</span>
        </div>
        <div class="about-row">
          <span class="about-label">Version</span>
          <span class="about-value">{appVersion}</span>
        </div>
        <div class="about-row">
          <span class="about-label">Gateway Protocol</span>
          <span class="about-value">JSON-RPC 2.0 over WebSocket</span>
        </div>
        <div class="about-row">
          <span class="about-label">Default Port</span>
          <span class="about-value">8419</span>
        </div>
      </div>
    </section>
  </div>
</div>

<style>
  .settings-page {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .settings-header {
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }

  .settings-header h2 {
    font-size: 16px;
    font-weight: 600;
  }

  .settings-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 28px;
    max-width: 560px;
  }

  .settings-section {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  .connection-info {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    background: var(--bg-secondary);
    border-radius: var(--radius);
    border: 1px solid var(--border);
  }

  .status-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .status-text {
    font-size: 13px;
    color: var(--text-secondary);
    text-transform: capitalize;
  }

  .status-text strong {
    color: var(--text-primary);
  }

  .form-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .form-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
  }

  .form-group input[type="text"],
  .form-group input[type="number"],
  .form-group input[type="password"] {
    width: 100%;
  }

  .form-group-inline {
    flex-direction: row;
    align-items: center;
    gap: 8px;
  }

  .form-group-inline .form-label {
    margin: 0;
  }

  .form-group input:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .button-group {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 4px;
  }

  .btn {
    padding: 8px 18px;
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 600;
    transition: background-color 0.15s, opacity 0.15s;
  }

  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .btn-connect {
    background: var(--success);
    color: white;
  }

  .btn-connect:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .btn-disconnect {
    background: var(--error);
    color: white;
  }

  .btn-disconnect:hover {
    filter: brightness(1.1);
  }

  .btn-save {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .btn-save:hover:not(:disabled) {
    background: var(--accent);
  }

  .btn-reset {
    background: none;
    color: var(--text-secondary);
  }

  .btn-reset:hover:not(:disabled) {
    color: var(--text-primary);
  }

  .about-info {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .about-row {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
  }

  .about-label {
    color: var(--text-secondary);
  }

  .about-value {
    color: var(--text-primary);
  }

  .update-available {
    color: var(--success);
    font-weight: 600;
  }

  .update-error {
    padding: 10px 14px;
    background: color-mix(in srgb, var(--error) 10%, transparent);
    border: 1px solid var(--error);
    border-radius: var(--radius);
    color: var(--error);
    font-size: 12px;
    word-break: break-word;
  }

  .update-progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .progress-bar {
    height: 6px;
    background: var(--bg-tertiary);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .progress-text {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .btn-update {
    background: var(--accent);
    color: white;
  }

  .btn-update:hover {
    filter: brightness(1.1);
  }
</style>
