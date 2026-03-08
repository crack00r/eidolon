<script lang="ts">
/**
 * ServerSetup -- 4-step server onboarding flow.
 * 1. Identity: name input
 * 2. Credentials: Claude connection (OAuth primary, API key secondary)
 * 3. Setup: animated progress checklist
 * 4. Ready: confirmation with pairing URL
 */
import { onMount, onDestroy } from "svelte";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  onComplete: () => void;
  onBack: () => void;
}

let { onComplete, onBack }: Props = $props();

type Step = "identity" | "credentials" | "setup" | "ready";
type CredentialType = "oauth" | "api-key";

let step = $state<Step>("identity");
let name = $state("");
let credentialType = $state<CredentialType>("oauth");
let apiKey = $state("");
let setupError = $state<string | null>(null);
let pairingUrl = $state("");
let fullPairingUrl = $state("");
let copied = $state(false);
let oauthLoading = $state(false);
let oauthError = $state<string | null>(null);

interface ChecklistItem {
  label: string;
  status: "pending" | "running" | "done" | "error";
}

let checklist = $state<ChecklistItem[]>([
  { label: "Generating master key", status: "pending" },
  { label: "Writing configuration", status: "pending" },
  { label: "Generating auth token", status: "pending" },
  { label: "Detecting network", status: "pending" },
  { label: "Preparing data directory", status: "pending" },
]);

onMount(async () => {
  try {
    const osUser = await invoke<string>("get_os_username");
    if (osUser) name = osUser;
  } catch {
    // Ignore -- user can type manually
  }
});

function nextToCredentials(): void {
  if (!name.trim()) return;
  step = "credentials";
}

async function startOAuthSetup(): Promise<void> {
  oauthLoading = true;
  oauthError = null;
  try {
    await invoke<string>("setup_claude_token");
    credentialType = "oauth";
    step = "setup";
    runSetup();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    oauthError = msg;
  } finally {
    oauthLoading = false;
  }
}

function startApiKeySetup(): void {
  if (!apiKey.trim()) return;
  credentialType = "api-key";
  step = "setup";
  runSetup();
}

async function runSetup(): Promise<void> {
  setupError = null;

  for (const item of checklist) {
    item.status = "pending";
  }

  checklist[0].status = "running";

  try {
    const result = await invoke<Record<string, unknown>>("onboard_setup_server", {
      name: name.trim(),
      credentialType: credentialType,
      apiKey: credentialType === "api-key" ? apiKey : null,
    });

    for (const item of checklist) {
      item.status = "done";
    }

    if (result.tailscaleIp || result.host) {
      const host = (result.tailscaleIp || result.host || "127.0.0.1") as string;
      const port = (result.port || 8419) as number;
      const tokenStr = (result.token || "") as string;
      fullPairingUrl = `eidolon://${host}:${port}?token=${encodeURIComponent(tokenStr)}`;
      // Mask the token in the display to prevent accidental exposure
      const maskedToken = tokenStr.length > 8
        ? `${tokenStr.slice(0, 4)}${"*".repeat(tokenStr.length - 8)}${tokenStr.slice(-4)}`
        : "*".repeat(tokenStr.length);
      pairingUrl = `eidolon://${host}:${port}?token=${maskedToken}`;
    } else {
      fullPairingUrl = "eidolon://127.0.0.1:8419";
      pairingUrl = "eidolon://127.0.0.1:8419";
    }

    step = "ready";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setupError = msg;
    for (const item of checklist) {
      if (item.status === "running") {
        item.status = "error";
        break;
      }
    }
  }
}

/** Timer handle for clearing the clipboard after copy. */
let clipboardClearTimer: ReturnType<typeof setTimeout> | null = null;

onDestroy(() => {
  if (clipboardClearTimer !== null) {
    clearTimeout(clipboardClearTimer);
    clipboardClearTimer = null;
  }
});

async function copyPairingUrl(): Promise<void> {
  try {
    await navigator.clipboard.writeText(fullPairingUrl);
    copied = true;
    setTimeout(() => { copied = false; }, 2000);

    // Clear the clipboard after 30 seconds to prevent token leakage
    if (clipboardClearTimer !== null) clearTimeout(clipboardClearTimer);
    clipboardClearTimer = setTimeout(async () => {
      clipboardClearTimer = null;
      try {
        await navigator.clipboard.writeText("");
      } catch {
        // Best-effort: clipboard may not be accessible
      }
    }, 30_000);
  } catch {
    // Fallback: ignore clipboard errors
  }
}

function statusIcon(status: ChecklistItem["status"]): string {
  switch (status) {
    case "done":
      return "[ok]";
    case "running":
      return "[..]";
    case "error":
      return "[!!]";
    default:
      return "[  ]";
  }
}
</script>

<div class="server-setup">
  {#if step === "identity"}
    <div class="step-panel">
      <button class="ed-btn ed-btn--ghost btn-back" onclick={onBack}>Back</button>
      <h1 class="step-title">Set up your server</h1>
      <p class="step-desc">Let's get Eidolon running. First, what should we call you?</p>

      <div class="form-group">
        <label class="form-label" for="name-input">Your name</label>
        <input
          id="name-input"
          type="text"
          bind:value={name}
          placeholder="Enter your name"
          maxlength="100"
        />
      </div>

      <button
        class="ed-btn ed-btn--primary btn-wide"
        disabled={!name.trim()}
        onclick={nextToCredentials}
      >
        Next
      </button>
    </div>

  {:else if step === "credentials"}
    <div class="step-panel">
      <button class="ed-btn ed-btn--ghost btn-back" onclick={() => { step = "identity"; }}>Back</button>
      <h1 class="step-title">Connect to Claude</h1>
      <p class="step-desc">Eidolon needs its own connection to Claude. This will open your browser to authorize.</p>

      <div class="oauth-section">
        <div class="oauth-label">
          <span class="option-badge">Recommended</span>
          <span class="option-title">Authorize Eidolon (OAuth)</span>
        </div>
        <p class="option-desc">
          Creates a long-lived OAuth token for Eidolon via <code>claude setup-token</code>.
          This opens your browser to authorize Eidolon independently from your personal Claude CLI session.
        </p>
        <button
          class="ed-btn ed-btn--primary btn-wide"
          disabled={oauthLoading}
          onclick={startOAuthSetup}
        >
          {#if oauthLoading}
            Waiting for authorization...
          {:else}
            Authorize Eidolon
          {/if}
        </button>
        {#if oauthError}
          <div class="ed-banner ed-banner--error" role="alert">
            <span>{oauthError}</span>
          </div>
        {/if}
      </div>

      <details class="apikey-details">
        <summary class="apikey-summary">Use API Key instead</summary>
        <div class="apikey-content">
          <p class="option-desc">
            For users who prefer using an Anthropic API key directly.
          </p>
          <div class="form-group">
            <label class="form-label" for="apikey-input">API Key</label>
            <input
              id="apikey-input"
              type="password"
              bind:value={apiKey}
              placeholder="sk-ant-..."
              maxlength="256"
            />
            <a
              class="key-help-link"
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
            >
              Get a key at console.anthropic.com
            </a>
          </div>
          <button
            class="ed-btn ed-btn--secondary btn-wide"
            disabled={!apiKey.trim()}
            onclick={startApiKeySetup}
          >
            Start Setup with API Key
          </button>
        </div>
      </details>
    </div>

  {:else if step === "setup"}
    <div class="step-panel">
      <h1 class="step-title">Setting up Eidolon</h1>
      <p class="step-desc">This will take a moment...</p>

      <div class="checklist" role="list" aria-label="Setup progress">
        {#each checklist as item}
          <div class="checklist-item {item.status}" role="listitem">
            <span class="checklist-icon" aria-hidden="true">{statusIcon(item.status)}</span>
            <span class="checklist-label">{item.label}</span>
          </div>
        {/each}
      </div>

      {#if setupError}
        <div class="ed-banner ed-banner--error" role="alert">
          <span>{setupError}</span>
          <button class="ed-btn ed-btn--secondary btn-retry" onclick={runSetup}>
            Retry
          </button>
        </div>
      {/if}
    </div>

  {:else if step === "ready"}
    <div class="step-panel">
      <div class="ready-indicator" aria-hidden="true"></div>
      <h1 class="step-title">Eidolon is ready!</h1>
      <p class="step-desc">Your server is running. Share this pairing URL with other devices.</p>

      {#if pairingUrl}
        <div class="pairing-url">
          <code>{pairingUrl}</code>
          <button class="ed-btn ed-btn--ghost btn-copy" onclick={copyPairingUrl}>
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p class="token-warning">The token is masked for security. Use the Copy button to get the full URL.</p>
      {/if}

      <button class="ed-btn ed-btn--primary btn-wide" onclick={onComplete}>
        Go to Dashboard
      </button>
    </div>
  {/if}
</div>

<style>
  .server-setup {
    height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg-primary);
  }

  .step-panel {
    max-width: 520px;
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

  .btn-wide {
    width: 100%;
    padding: 12px 16px;
    font-size: var(--ed-text-base);
  }

  .key-help-link {
    font-size: var(--ed-text-sm);
    color: var(--accent);
    text-decoration: none;
  }

  .key-help-link:hover {
    text-decoration: underline;
  }

  /* OAuth section */
  .oauth-section {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    background: var(--bg-secondary);
    border: 2px solid var(--accent);
    border-radius: var(--radius);
  }

  .oauth-label {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .option-badge {
    font-size: var(--ed-text-xs, 0.75rem);
    font-weight: var(--ed-weight-bold);
    color: var(--accent);
    text-transform: uppercase;
    letter-spacing: var(--ed-tracking-wide);
    padding: 2px 8px;
    border: 1px solid var(--accent);
    border-radius: var(--radius);
  }

  .option-title {
    font-size: var(--ed-text-base);
    font-weight: var(--ed-weight-semibold);
    color: var(--text-primary);
  }

  .option-desc {
    font-size: var(--ed-text-sm);
    color: var(--text-secondary);
    line-height: var(--ed-leading-relaxed);
  }

  .option-desc code {
    font-size: var(--ed-text-sm);
    color: var(--accent);
    background: var(--bg-primary);
    padding: 1px 5px;
    border-radius: 3px;
  }

  /* API key details (collapsed) */
  .apikey-details {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .apikey-summary {
    padding: 12px 16px;
    font-size: var(--ed-text-sm);
    color: var(--text-secondary);
    cursor: pointer;
    user-select: none;
  }

  .apikey-summary:hover {
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  .apikey-content {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 0 16px 16px;
  }

  /* Checklist */
  .checklist {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .checklist-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: var(--ed-text-base);
    color: var(--text-secondary);
    transition:
      color var(--ed-duration-normal) var(--ed-ease),
      border-color var(--ed-duration-normal) var(--ed-ease);
  }

  .checklist-item.done {
    color: var(--success);
    border-color: var(--success);
  }

  .checklist-item.running {
    color: var(--accent);
    border-color: var(--accent);
  }

  .checklist-item.error {
    color: var(--error);
    border-color: var(--error);
  }

  .checklist-icon {
    font-size: var(--ed-text-sm);
    font-weight: var(--ed-weight-bold);
    font-variant-numeric: tabular-nums;
    min-width: 32px;
    text-align: center;
  }

  .checklist-label {
    flex: 1;
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

  .pairing-url {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow-x: auto;
  }

  .pairing-url code {
    font-size: var(--ed-text-sm);
    color: var(--accent);
    word-break: break-all;
    flex: 1;
  }

  .btn-copy {
    flex-shrink: 0;
    font-size: var(--ed-text-sm);
    padding: 4px 10px;
  }

  .token-warning {
    font-size: var(--ed-text-xs);
    color: var(--text-secondary);
    margin-top: -12px;
  }

  .btn-back {
    align-self: flex-start;
    font-size: var(--ed-text-sm);
    padding: 4px 10px;
  }

  .btn-retry {
    flex-shrink: 0;
    font-size: var(--ed-text-sm);
    padding: 6px 14px;
  }
</style>
