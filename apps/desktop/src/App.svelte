<script lang="ts">
import Layout from "./routes/+layout.svelte";
import DashboardPage from "./routes/dashboard/+page.svelte";
import ChatPage from "./routes/chat/+page.svelte";
import LearningPage from "./routes/learning/+page.svelte";
import MemoryPage from "./routes/memory/+page.svelte";
import SettingsPage from "./routes/settings/+page.svelte";

let currentRoute = $state("dashboard");

function navigate(route: string): void {
  currentRoute = route;
}
</script>

<Layout {currentRoute} onNavigate={navigate}>
  {#if currentRoute === "dashboard"}
    <DashboardPage />
  {:else if currentRoute === "chat"}
    <ChatPage />
  {:else if currentRoute === "memory"}
    <MemoryPage />
  {:else if currentRoute === "learning"}
    <LearningPage />
  {:else if currentRoute === "settings"}
    <SettingsPage />
  {/if}
</Layout>
