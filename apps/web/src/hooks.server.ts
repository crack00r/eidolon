/**
 * Server hooks — adds security headers to all responses.
 * This is the primary security layer for the web interface.
 */

import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  // Strict Transport Security (1 year)
  response.headers.set(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains",
  );

  // Content Security Policy
  // NOTE: connect-src is pinned to the default gateway port 8419. If the port
  // becomes user-configurable, widen to wss://localhost:* wss://127.0.0.1:*.
  // TODO: In production, add a `report-to` directive pointing at a CSP
  // violation reporting endpoint (e.g. report-uri.com or a self-hosted collector).
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' wss://localhost:8419 wss://127.0.0.1:8419",
      "img-src 'self' data:",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );

  // Prevent clickjacking
  response.headers.set("X-Frame-Options", "DENY");

  // Prevent MIME sniffing
  response.headers.set("X-Content-Type-Options", "nosniff");

  // Referrer policy
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions policy
  response.headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(self), geolocation=()",
  );

  // Prevent cross-domain content loading (Flash/PDF policies)
  response.headers.set("X-Permitted-Cross-Domain-Policies", "none");

  // Prevent DNS prefetch to avoid information leakage
  response.headers.set("X-DNS-Prefetch-Control", "off");

  return response;
};
