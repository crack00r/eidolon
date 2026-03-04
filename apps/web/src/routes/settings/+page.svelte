<script lang="ts">
import { onMount } from "svelte";
import { connect, connectionState, disconnect, isConnected } from "$lib/stores/connection";
import { resetSettings, settingsStore, updateSettings } from "$lib/stores/settings";

let host = $state($settingsStore.host);
let port = $state($settingsStore.port);
let token = $state($settingsStore.token);
let useTls = $state($settingsStore.useTls);
let saved = $state(false);

// Auto-detect state
let autoDetectStatus = $state<"idle" | "checking" | "found" | "not-found">("idle");
let detectedHost = $state<string | null>(null);
let detectedPort = $state<number | null>(null);

// Pairing URL state
let pairingUrl = $state("");
let pairingError = $state<string | null>(null);
let pairingParsed = $state<{ host: string; port: number; token: string; tls: boolean } | null>(null);

onMount(() => {
  // Auto-detect: if the web app is served from the same host as the server,
  // try connecting to the discovery endpoint
  tryAutoDetect();
});

async function tryAutoDetect(): Promise<void> {
  autoDetectStatus = "checking";

  // First, try the origin host (web app served from the server itself)
  const originHost = window.location.hostname;
  const healthPort = 9419;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(`http://${originHost}:${healthPort}/discovery`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as {
        service?: string;
        hostname?: string;
        gateway?: { host?: string; port?: number; tls?: boolean };
      };

      if (data.service === "eidolon" && data.gateway) {
        detectedHost = data.gateway.host ?? originHost;
        detectedPort = data.gateway.port ?? 8419;
        autoDetectStatus = "found";
        return;
      }
    }
  } catch {
    // Origin host didn't work, try localhost
  }

  // Try localhost if origin didn't work
  if (originHost !== "127.0.0.1" && originHost !== "localhost") {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);

      const res = await fetch(`http://127.0.0.1:${healthPort}/discovery`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = (await res.json()) as {
          service?: string;
          gateway?: { host?: string; port?: number; tls?: boolean };
        };

        if (data.service === "eidolon" && data.gateway) {
          detectedHost = data.gateway.host ?? "127.0.0.1";
          detectedPort = data.gateway.port ?? 8419;
          autoDetectStatus = "found";
          return;
        }
      }
    } catch {
      // localhost didn't work either
    }
  }

  autoDetectStatus = "not-found";
}

function handleApplyDetected(): void {
  if (detectedHost && detectedPort) {
    host = detectedHost;
    port = detectedPort;
    useTls = false;
  }
}

async function handleTryLocalServer(): Promise<void> {
  autoDetectStatus = "checking";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch("http://127.0.0.1:9419/discovery", {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.ok) {
      const data = (await res.json()) as {
        service?: string;
        gateway?: { host?: string; port?: number; tls?: boolean };
      };

      if (data.service === "eidolon" && data.gateway) {
        detectedHost = data.gateway.host ?? "127.0.0.1";
        detectedPort = data.gateway.port ?? 8419;
        autoDetectStatus = "found";
        return;
      }
    }

    autoDetectStatus = "not-found";
  } catch {
    autoDetectStatus = "not-found";
  }
}

function parsePairingUrl(url: string): { host: string; port: number; token: string; tls: boolean } | null {
  try {
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

      <div class="connection-info" role="status" aria-live="polite">
        <span
          class="status-dot"
          style="background-color: {stateColor($connectionState)}"
          aria-hidden="true"
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
          disabled={$isConnected}
          autocomplete="off"
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
        Auto-detect an Eidolon server on the local machine or same network origin.
      </p>

      {#if autoDetectStatus === "checking"}
        <div class="discovery-status" role="status" aria-live="polite">
          Checking for local server...
        </div>
      {/if}

      {#if autoDetectStatus === "found" && detectedHost && detectedPort}
        <div class="discovery-found">
          <div class="about-row">
            <span class="about-label">Detected Server</span>
            <span class="about-value">{detectedHost}:{detectedPort}</span>
          </div>
          <div class="button-group">
            <button class="btn btn-connect" onclick={handleApplyDetected} disabled={$isConnected}>
              Use Detected Server
            </button>
          </div>
        </div>
      {/if}

      {#if autoDetectStatus === "not-found"}
        <div class="discovery-empty">
          No server detected automatically.
        </div>
      {/if}

      <div class="button-group">
        <button
          class="btn btn-save"
          onclick={handleTryLocalServer}
          disabled={autoDetectStatus === "checking" || $isConnected}
        >
          Try Local Server
        </button>
      </div>
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
        <div class="discovery-error" role="alert">
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
      <h3 class="section-title">About</h3>
      <div class="about-info">
        <div class="about-row">
          <span class="about-label">Application</span>
          <span class="about-value">Eidolon Web</span>
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
        <div class="about-row">
          <span class="about-label">Token Storage</span>
          <span class="about-value">sessionStorage (cleared on tab close)</span>
        </div>
      </div>
    </section>

    <section class="settings-section">
      <h3 class="section-title">Security</h3>
      <div class="security-note">
        <p>
          Settings and authentication tokens are stored in <strong>sessionStorage</strong>,
          which is automatically cleared when you close this browser tab.
          This is more secure than localStorage for sensitive credentials.
        </p>
        <p>
          All responses include Content-Security-Policy, HSTS, and
          X-Frame-Options headers for defense-in-depth.
        </p>
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

  .security-note {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.6;
  }

  .security-note p {
    margin-bottom: 8px;
  }

  .security-note strong {
    color: var(--text-primary);
  }

  .section-desc {
    font-size: 13px;
    color: var(--text-secondary);
    line-height: 1.5;
  }

  .discovery-status {
    padding: 10px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 13px;
  }

  .discovery-found {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 10px 14px;
    background: color-mix(in srgb, var(--success) 8%, transparent);
    border: 1px solid var(--success);
    border-radius: var(--radius);
  }

  .discovery-empty {
    padding: 10px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-secondary);
    font-size: 13px;
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
