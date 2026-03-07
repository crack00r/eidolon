<script lang="ts">
/**
 * RoleSelect -- First screen of the onboarding flow.
 * Lets the user pick between running as a server (brain) or connecting as a client.
 */

interface Props {
  onSelect: (role: "server" | "client") => void;
}

let { onSelect }: Props = $props();
</script>

<div class="role-select">
  <div class="hero">
    <h1 class="logo">Eidolon</h1>
    <p class="tagline">Your autonomous AI assistant</p>
  </div>

  <div class="cards">
    <button class="role-card" onclick={() => onSelect("server")}>
      <span class="role-icon" aria-hidden="true">[S]</span>
      <h2 class="role-title">Start as Server</h2>
      <p class="role-desc">Run your own AI brain on this machine</p>
    </button>

    <button class="role-card" onclick={() => onSelect("client")}>
      <span class="role-icon" aria-hidden="true">[C]</span>
      <h2 class="role-title">Connect as Client</h2>
      <p class="role-desc">Connect to an existing Eidolon server</p>
    </button>
  </div>
</div>

<style>
  .role-select {
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 48px;
    padding: 24px;
    background: var(--bg-primary);
  }

  .hero {
    text-align: center;
  }

  .logo {
    font-size: var(--ed-text-3xl);
    font-weight: var(--ed-weight-bold);
    color: var(--accent);
    margin-bottom: 8px;
  }

  .tagline {
    font-size: var(--ed-text-md);
    color: var(--text-secondary);
  }

  .cards {
    display: flex;
    gap: 24px;
  }

  @media (max-width: 600px) {
    .cards {
      flex-direction: column;
    }
  }

  .role-card {
    width: 260px;
    padding: 32px 24px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--ed-radius-lg);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    text-align: center;
    color: var(--text-primary);
    transition:
      border-color var(--ed-duration-normal) var(--ed-ease),
      box-shadow var(--ed-duration-normal) var(--ed-ease);
  }

  .role-card:hover {
    border-color: var(--accent);
    box-shadow: var(--ed-glow-accent);
  }

  .role-icon {
    font-size: var(--ed-text-2xl);
    font-weight: var(--ed-weight-bold);
    color: var(--accent);
  }

  .role-title {
    font-size: var(--ed-text-lg);
    font-weight: var(--ed-weight-semibold);
    color: var(--text-primary);
  }

  .role-desc {
    font-size: var(--ed-text-base);
    color: var(--text-secondary);
    line-height: var(--ed-leading-relaxed);
  }
</style>
