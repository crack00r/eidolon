import { mount } from "svelte";
import App from "./App.svelte";
import { clientLog } from "./lib/logger";

// Global error handlers — catch unhandled errors and promise rejections
// so they are logged to the ring buffer for phone-home diagnostics.
window.onerror = (message: string | Event, source?: string, lineno?: number, colno?: number, error?: Error): void => {
  clientLog("error", "global", String(message), {
    source,
    lineno,
    colno,
    stack: error?.stack,
  });
};

window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  clientLog("error", "global", `Unhandled promise rejection: ${message}`, { stack });
});

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
