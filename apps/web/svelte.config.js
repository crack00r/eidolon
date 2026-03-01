import adapter from "@sveltejs/adapter-node";

/** @type {import('@sveltejs/kit').Config} */
export default {
  kit: {
    adapter: adapter({
      out: "build",
    }),
    // CSRF protection: SvelteKit verifies the Origin header on form submissions
    // and non-GET requests. Only localhost origins are trusted (gateway runs locally).
    csrf: {
      trustedOrigins: ["http://localhost:*", "https://localhost:*", "http://127.0.0.1:*", "https://127.0.0.1:*"],
    },
  },
};
