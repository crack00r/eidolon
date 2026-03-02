<script lang="ts">
import { onMount } from "svelte";
import { getVersion } from "@tauri-apps/api/app";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { connect, connectionState, disconnect, isConnected } from "../../lib/stores/connection";
import {
  resetSettings,
  setAutoCheck,
  setLastChecked,
  settingsStore,
  updateSettings,
  updateSettingsStore,
} from "../../lib/stores/settings";

interface DiscoveredServer {
  service: string;
  version: string;
  host: string;
  port: number;
  hostname: string;
  tailscaleIp?: string;
  tls: boolean;
}

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

// Discovery state
let discoveryStatus = $state<"idle" | "scanning" | "done" | "error">("idle");
let discoveryError = $state<string | null>(null);
let discoveredServers = $state<DiscoveredServer[]>([]);

// Pairing URL state
let pairingUrl = $state("");
let pairingError = $state<string | null>(null);
let pairingParsed = $state<{ host: string; port: number; token: string; tls: boolean } | null>(null);

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

async function handleDiscoverServers(): Promise<void> {
  discoveryStatus = "scanning";
  discoveryError = null;
  discoveredServers = [];

  try {
    const servers = await invoke<DiscoveredServer[]>("discover_servers", { timeoutMs: 3000 });
    discoveredServers = servers;
    discoveryStatus = "done";
  } catch (err) {
    discoveryStatus = "error";
    discoveryError = err instanceof Error ? err.message : String(err);
  }
}

function handleSelectServer(server: DiscoveredServer): void {
  host = server.host;
  port = server.port;
  useTls = server.tls;
  // Don't overwrite the token — user must provide it separately
}

function parsePairingUrl(url: string): { host: string; port: number; token: string; tls: boolean } | null {
  try {
    // Expected format: eidolon://host:port?token=xxx&tls=true
    const normalized = url.trim();
    if (!normalized.startsWith("eidolon://")) return null;

    // Replace eidolon:// with https:// so URL parser can handle it
    const asUrl = new URL(normalized.replace("eidolon://", "https://"));
    const parsedHost = asUrl.hostname;
    const parsedPort = asUrl.port ? Number.parseInt(asUrl.port, 10) : 8419;
    const parsedToken = asUrl.searchParams.get("token") ?? "";
    const parsedTls = asUrl.searchParams.get("tls") === "true";

    if (!parsedHost || parsedPort < 1 || parsedPort > 65535) return null;

    return { host: parsedHost, port: parsedPort, token: parsedToken, tls: parsedTls };
  } catch {
    return null;
  }
}

function handlePairingUrlInput(): void {
  pairingError = null;
  pairingParsed = null;

  if (!pairingUrl.trim()) return;

  const parsed = parsePairingUrl(pairingUrl);
  if (parsed) {
    pairingParsed = parsed;
  } else {
    pairingError = "Invalid pairing URL. Expected format: eidolon://host:port?token=xxx&tls=true";
  }
}

function handleApplyPairing(): void {
  if (!pairingParsed) return;

  host = pairingParsed.host;
  port = pairingParsed.port;
  token = pairingParsed.token;
  useTls = pairingParsed.tls;
  pairingUrl = "";
  pairingParsed = null;
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
      <h3 class="section-title">Server Discovery</h3>

      <p class="section-desc">
        Scan the local network for Eidolon servers broadcasting on UDP port 41920.
      </p>

      <div class="button-group">
        <button
          class="btn btn-connect"
          onclick={handleDiscoverServers}
          disabled={discoveryStatus === "scanning" || $isConnected}
        >
          {discoveryStatus === "scanning" ? "Scanning..." : "Scan for Servers"}
        </button>
      </div>

      {#if discoveryStatus === "error" && discoveryError}
        <div class="discovery-error">
          {discoveryError}
        </div>
      {/if}

      {#if discoveryStatus === "done" && discoveredServers.length === 0}
        <div class="discovery-empty">
          No servers found. Make sure the Eidolon server is running and broadcasting.
        </div>
      {/if}

      {#if discoveredServers.length > 0}
        <div class="server-list">
          {#each discoveredServers as server}
            <button
              class="server-card"
              onclick={() => handleSelectServer(server)}
              disabled={$isConnected}
            >
              <div class="server-hostname">{server.hostname}</div>
              <div class="server-details">
                <span>{server.host}:{server.port}</span>
                <span class="server-version">v{server.version}</span>
                {#if server.tls}
                  <span class="server-tls">TLS</span>
                {/if}
              </div>
              {#if server.tailscaleIp}
                <div class="server-tailscale">Tailscale: {server.tailscaleIp}</div>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <section class="settings-section">
      <h3 class="section-title">Pairing URL</h3>

      <p class="section-desc">
        Paste a pairing URL to auto-fill connection settings.
      </p>

      <div class="form-group">
        <label class="form-label" for="pairingUrl">Pairing URL</label>
        <input
          id="pairingUrl"
          type="text"
          bind:value={pairingUrl}
          oninput={handlePairingUrlInput}
          placeholder="eidolon://host:port?token=xxx&tls=true"
          disabled={$isConnected}
        />
      </div>

      {#if pairingError}
        <div class="discovery-error">
          {pairingError}
        </div>
      {/if}

      {#if pairingParsed}
        <div class="pairing-preview">
          <div class="about-row">
            <span class="about-label">Host</span>
            <span class="about-value">{pairingParsed.host}</span>
          </div>
          <div class="about-row">
            <span class="about-label">Port</span>
            <span class="about-value">{pairingParsed.port}</span>
          </div>
          <div class="about-row">
            <span class="about-label">Token</span>
            <span class="about-value">{pairingParsed.token ? "***" : "(none)"}</span>
          </div>
          <div class="about-row">
            <span class="about-label">TLS</span>
            <span class="about-value">{pairingParsed.tls ? "Yes" : "No"}</span>
          </div>
        </div>

        <div class="button-group">
          <button class="btn btn-connect" onclick={handleApplyPairing} disabled={$isConnected}>
            Apply Pairing
          </button>
        </div>
      {/if}
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

  .section-desc {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .discovery-error {
    padding: 10px 14px;
    background: color-mix(in srgb, var(--error) 10%, transparent);
    border: 1px solid var(--error);
    border-radius: var(--radius);
    color: var(--error);
    font-size: 12px;
    word-break: break-word;
  }

  .discovery-empty {
    padding: 10px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 13px;
  }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .server-card {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 12px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    cursor: pointer;
    text-align: left;
    transition: border-color 0.15s, background-color 0.15s;
  }

  .server-card:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--bg-tertiary);
  }

  .server-card:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .server-hostname {
    font-size: 14px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .server-details {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .server-version {
    color: var(--accent);
  }

  .server-tls {
    color: var(--success);
    font-weight: 600;
  }

  .server-tailscale {
    font-size: 11px;
    color: var(--text-secondary);
    opacity: 0.8;
  }

  .pairing-preview {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
</style>
