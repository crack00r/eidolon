<script lang="ts">
import { onMount } from "svelte";
import { goto } from "$app/navigation";

onMount(() => {
  goto("/dashboard", { replaceState: true });
});
</script>

<div class="redirect">
  <p>Redirecting to dashboard...</p>
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
