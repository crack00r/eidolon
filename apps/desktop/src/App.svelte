<script lang="ts">
  import Layout from "./routes/+layout.svelte";
  import ChatPage from "./routes/chat/+page.svelte";
  import MemoryPage from "./routes/memory/+page.svelte";
  import LearningPage from "./routes/learning/+page.svelte";
  import SettingsPage from "./routes/settings/+page.svelte";

  let currentRoute = $state("chat");

  function navigate(route: string): void {
    currentRoute = route;
  }
</script>

<Layout {currentRoute} onNavigate={navigate}>
  {#if currentRoute === "chat"}
    <ChatPage />
  {:else if currentRoute === "memory"}
    <MemoryPage />
  {:else if currentRoute === "learning"}
    <LearningPage />
  {:else if currentRoute === "settings"}
    <SettingsPage />
  {/if}
</Layout>
