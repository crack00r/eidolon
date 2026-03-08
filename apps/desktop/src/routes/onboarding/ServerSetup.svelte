<script lang="ts">
/**
 * ServerSetup -- 3-step server onboarding flow.
 * 1. Identity: name + Claude credentials
 * 2. Setup: animated progress checklist
 * 3. Ready: confirmation with pairing URL
 */
import { onMount } from "svelte";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  onComplete: () => void;
}

let { onComplete }: Props = $props();

type Step = "identity" | "setup" | "ready";

let step = $state<Step>("identity");
let name = $state("");
let credentialType = $state<"oauth" | "apikey">("oauth");
let apiKey = $state("");
let setupError = $state<string | null>(null);
let pairingUrl = $state("");

// Setup progress checklist
interface ChecklistItem {
  label: string;
  status: "pending" | "running" | "done" | "error";
}

let checklist = $state<ChecklistItem[]>([
  { label: "Generating master key", status: "pending" },
  { label: "Initializing secret store", status: "pending" },
  { label: "Creating databases", status: "pending" },
  { label: "Configuring network", status: "pending" },
  { label: "Installing CLI", status: "pending" },
]);

onMount(async () => {
  try {
    const osUser = await invoke<string>("get_os_username");
    if (osUser) name = osUser;
  } catch {
    // Ignore -- user can type manually
  }
});

function startSetup(): void {
  if (!name.trim()) return;
  step = "setup";
  runSetup();
}

async function runSetup(): Promise<void> {
  setupError = null;

  // Set all to pending initially
  for (const item of checklist) {
    item.status = "pending";
  }

  // Mark first item as running
  checklist[0].status = "running";

  try {
    const rawResult = await invoke<string>("onboard_setup_server", {
      name: name.trim(),
      credentialType,
      apiKey: credentialType === "apikey" ? apiKey : undefined,
    });

    // Mark all as done on success
    for (const item of checklist) {
      item.status = "done";
    }

    // Parse the result -- backend may return a JSON string or an object
    const result = typeof rawResult === "string" ? JSON.parse(rawResult) as Record<string, unknown> : rawResult as Record<string, unknown>;

    // Construct pairing URL from result fields
    if (result.tailscaleIp || result.host) {
      const host = (result.tailscaleIp || result.host || "127.0.0.1") as string;
      const port = (result.port || 8419) as number;
      const token = (result.token || "") as string;
      pairingUrl = `eidolon://${host}:${port}?token=${token}`;
    } else {
      pairingUrl = "eidolon://127.0.0.1:8419";
    }

    step = "ready";
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    setupError = msg;
    // Mark first running item as error, rest stay pending
    for (const item of checklist) {
      if (item.status === "running") {
        item.status = "error";
        break;
      }
    }
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
      <h1 class="step-title">Set up your server</h1>
      <p class="step-desc">Tell us who you are and how to connect to Claude.</p>

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
        onclick={() => { credentialType = "oauth"; startSetup(); }}
      >
        Connect with Claude
      </button>

      <details class="alt-section">
        <summary class="alt-summary">Use API key instead</summary>
        <div class="form-group">
          <label class="form-label" for="apikey-input">API Key</label>
          <input
            id="apikey-input"
            type="password"
            bind:value={apiKey}
            placeholder="sk-ant-..."
            maxlength="256"
          />
        </div>
        <button
          class="ed-btn ed-btn--secondary btn-wide"
          disabled={!name.trim() || !apiKey.trim()}
          onclick={() => { credentialType = "apikey"; startSetup(); }}
        >
          Set up with API key
        </button>
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
        <div class="ed-banner ed-banner--error" role="alert">{setupError}</div>
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
        </div>
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
    max-width: 440px;
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
  }
</style>
