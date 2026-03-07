<script lang="ts">
/**
 * ClientSetup -- 2-step client onboarding flow.
 * 1. Discover: find or enter server address
 * 2. Connected: confirmation
 */
import { onMount } from "svelte";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  onComplete: () => void;
}

let { onComplete }: Props = $props();

type Step = "discover" | "connected";

interface DiscoveredServer {
  name: string;
  host: string;
  port: number;
  version: string;
}

let step = $state<Step>("discover");
let discovering = $state(false);
let servers = $state<DiscoveredServer[]>([]);
let discoverError = $state<string | null>(null);

// Manual entry
let pairingUrlInput = $state("");
let manualHost = $state("");
let manualPort = $state(8419);
let manualToken = $state("");
let connecting = $state(false);
let connectError = $state<string | null>(null);

// Connected info
let connectedServer = $state<{ host: string; port: number; name: string } | null>(null);

onMount(() => {
  discoverServers();
});

async function discoverServers(): Promise<void> {
  discovering = true;
  discoverError = null;
  try {
    const found = await invoke<DiscoveredServer[]>("discover_servers", { timeoutMs: 3000 });
    servers = found;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    discoverError = msg;
  } finally {
    discovering = false;
  }
}

function parsePairingUrl(url: string): { host: string; port: number; token: string } | null {
  try {
    // eidolon://host:port?token=xxx
    const cleaned = url.replace("eidolon://", "https://");
    const parsed = new URL(cleaned);
    const host = parsed.hostname;
    const port = Number.parseInt(parsed.port || "8419", 10);
    const token = parsed.searchParams.get("token") || "";
    if (!host) return null;
    return { host, port, token };
  } catch {
    return null;
  }
}

async function connectToServer(host: string, port: number, token: string): Promise<void> {
  connecting = true;
  connectError = null;

  try {
    // Test the connection
    const response = await fetch(`http://${host}:${port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error(`Server returned ${response.status}`);
    }

    // Persist client config via Tauri
    await invoke("save_client_config", { host, port, token });

    connectedServer = { host, port, name: `${host}:${port}` };
    step = "connected";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    connectError = `Connection failed: ${msg}`;
  } finally {
    connecting = false;
  }
}

function connectFromUrl(): void {
  const parsed = parsePairingUrl(pairingUrlInput.trim());
  if (!parsed) {
    connectError = "Invalid pairing URL format. Expected: eidolon://host:port?token=xxx";
    return;
  }
  connectToServer(parsed.host, parsed.port, parsed.token);
}

function connectManual(): void {
  if (!manualHost.trim()) return;
  connectToServer(manualHost.trim(), manualPort, manualToken.trim());
}

function connectToDiscovered(server: DiscoveredServer): void {
  connectToServer(server.host, server.port, "");
}
</script>

<div class="client-setup">
  {#if step === "discover"}
    <div class="step-panel">
      <h1 class="step-title">Connect to a server</h1>
      <p class="step-desc">Find your Eidolon server automatically or enter the address manually.</p>

      <!-- Auto-discovered servers -->
      <div class="discover-section">
        <h2 class="section-label">
          {#if discovering}
            Searching for servers...
          {:else if servers.length > 0}
            Found servers
          {:else}
            No servers found on your network
          {/if}
        </h2>

        {#if discoverError}
          <p class="discover-error">{discoverError}</p>
        {/if}

        {#if servers.length > 0}
          <div class="server-list">
            {#each servers as server}
              <button class="server-card" onclick={() => connectToDiscovered(server)}>
                <span class="server-name">{server.name}</span>
                <span class="server-addr">{server.host}:{server.port}</span>
                <span class="server-version">v{server.version}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if !discovering}
          <button class="ed-btn ed-btn--ghost btn-small" onclick={discoverServers}>
            Scan again
          </button>
        {/if}
      </div>

      <div class="divider">
        <span class="divider-text">or</span>
      </div>

      <!-- Pairing URL -->
      <div class="form-group">
        <label class="form-label" for="pairing-url">Pairing URL</label>
        <input
          id="pairing-url"
          type="text"
          bind:value={pairingUrlInput}
          placeholder="eidolon://192.168.1.100:8419?token=xxx"
        />
        <button
          class="ed-btn ed-btn--primary btn-wide"
          disabled={!pairingUrlInput.trim() || connecting}
          onclick={connectFromUrl}
        >
          {connecting ? "Connecting..." : "Connect"}
        </button>
      </div>

      <!-- Manual entry -->
      <details class="alt-section">
        <summary class="alt-summary">Enter host and port manually</summary>
        <div class="manual-fields">
          <div class="form-group">
            <label class="form-label" for="manual-host">Host</label>
            <input
              id="manual-host"
              type="text"
              bind:value={manualHost}
              placeholder="192.168.1.100"
            />
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="manual-port">Port</label>
              <input
                id="manual-port"
                type="number"
                bind:value={manualPort}
                min="1"
                max="65535"
              />
            </div>
            <div class="form-group">
              <label class="form-label" for="manual-token">Token</label>
              <input
                id="manual-token"
                type="password"
                bind:value={manualToken}
                placeholder="Optional"
              />
            </div>
          </div>
          <button
            class="ed-btn ed-btn--secondary btn-wide"
            disabled={!manualHost.trim() || connecting}
            onclick={connectManual}
          >
            {connecting ? "Connecting..." : "Connect manually"}
          </button>
        </div>
      </details>

      {#if connectError}
        <div class="ed-banner ed-banner--error" role="alert">{connectError}</div>
      {/if}
    </div>

  {:else if step === "connected"}
    <div class="step-panel">
      <div class="ready-indicator" aria-hidden="true"></div>
      <h1 class="step-title">Connected!</h1>
      {#if connectedServer}
        <p class="step-desc">
          Successfully connected to <strong>{connectedServer.name}</strong>.
        </p>
      {/if}

      <button class="ed-btn ed-btn--primary btn-wide" onclick={onComplete}>
        Go to Dashboard
      </button>
    </div>
  {/if}
</div>

<style>
  .client-setup {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg-primary);
    overflow-y: auto;
  }

  .step-panel {
    max-width: 480px;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .step-title {
    font-size: var(--ed-text-xl);
    font-weight: var(--ed-weight-bold);
    color: var(--text-primary);
  }

  .step-desc {
    font-size: var(--ed-text-base);
    color: var(--text-secondary);
    line-height: var(--ed-leading-relaxed);
  }

  .step-desc strong {
    color: var(--accent);
  }

  /* Discovery */
  .discover-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .section-label {
    font-size: var(--ed-text-sm);
    font-weight: var(--ed-weight-semibold);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--ed-tracking-wide);
  }

  .discover-error {
    font-size: var(--ed-text-sm);
    color: var(--error);
  }

  .server-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .server-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text-primary);
    text-align: left;
    transition:
      border-color var(--ed-duration-normal) var(--ed-ease),
      box-shadow var(--ed-duration-normal) var(--ed-ease);
  }

  .server-card:hover {
    border-color: var(--accent);
    box-shadow: var(--ed-glow-accent);
  }

  .server-name {
    font-weight: var(--ed-weight-semibold);
    flex: 1;
  }

  .server-addr {
    font-size: var(--ed-text-sm);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
  }

  .server-version {
    font-size: var(--ed-text-xs);
    color: var(--text-secondary);
  }

  /* Divider */
  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .divider::before,
  .divider::after {
    content: "";
    flex: 1;
    height: 1px;
    background: var(--border);
  }

  .divider-text {
    font-size: var(--ed-text-sm);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--ed-tracking-wide);
  }

  /* Form */
  .form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .form-label {
    font-size: var(--ed-text-sm);
    font-weight: var(--ed-weight-semibold);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: var(--ed-tracking-wide);
  }

  .form-row {
    display: flex;
    gap: 12px;
  }

  .form-row .form-group {
    flex: 1;
  }

  .btn-wide {
    width: 100%;
    padding: 12px 16px;
    font-size: var(--ed-text-base);
  }

  .btn-small {
    font-size: var(--ed-text-sm);
    padding: 6px 12px;
    align-self: flex-start;
  }

  .alt-section {
    margin-top: 4px;
  }

  .alt-summary {
    font-size: var(--ed-text-sm);
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
  }

  .alt-summary:hover {
    color: var(--accent);
  }

  .manual-fields {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 12px;
  }

  /* Ready state */
  .ready-indicator {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--success);
    box-shadow: var(--ed-glow-success);
    animation: pulse-ready 2s ease-in-out infinite;
  }

  @keyframes pulse-ready {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
</style>
