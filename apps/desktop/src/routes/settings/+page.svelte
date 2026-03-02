<script lang="ts">
import { connect, connectionState, disconnect, isConnected } from "../../lib/stores/connection";
import { resetSettings, settingsStore, updateSettings } from "../../lib/stores/settings";

let host = $state($settingsStore.host);
let port = $state($settingsStore.port);
let token = $state($settingsStore.token);
let useTls = $state($settingsStore.useTls);
let saved = $state(false);

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
      <h3 class="section-title">About</h3>
      <div class="about-info">
        <div class="about-row">
          <span class="about-label">Application</span>
          <span class="about-value">Eidolon Desktop</span>
        </div>
        <div class="about-row">
          <span class="about-label">Version</span>
          <span class="about-value">0.1.0</span>
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
</style>
