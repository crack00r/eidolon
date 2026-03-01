import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  build: {
    // SEC-SUPPLY-015: Do not ship source maps in production builds
    sourcemap: false,
  },
});
