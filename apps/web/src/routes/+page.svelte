<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";

  onMount(() => {
    goto("/chat", { replaceState: true });
  });
</script>

<div class="redirect">
  <p>Redirecting to chat...</p>
</div>

<style>
  .redirect {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-secondary);
    font-size: 14px;
  }
</style>
