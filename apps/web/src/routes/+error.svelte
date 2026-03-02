<script lang="ts">
import { page } from "$app/stores";
</script>

<div class="error-page">
  <div class="error-container">
    <h1 class="error-code">{$page.status}</h1>
    <p class="error-message">{$page.error?.message ?? "An unexpected error occurred"}</p>
    <a href="/chat" class="error-link">Back to Chat</a>
  </div>
</div>

<style>
  .error-page {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 40px 20px;
  }

  .error-container {
    text-align: center;
    max-width: 400px;
  }

  .error-code {
    font-size: 72px;
    font-weight: 700;
    color: var(--accent);
    line-height: 1;
    margin-bottom: 12px;
  }

  .error-message {
    font-size: 16px;
    color: var(--text-secondary);
    line-height: 1.5;
    margin-bottom: 24px;
  }

  .error-link {
    display: inline-block;
    padding: 10px 24px;
    background: var(--accent);
    color: white;
    border-radius: var(--radius);
    font-weight: 600;
    font-size: 14px;
    transition: background-color 0.15s;
  }

  .error-link:hover {
    background: var(--accent-hover);
    color: white;
  }
</style>
