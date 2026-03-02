/**
 * Server hooks — adds security headers to all responses.
 * This is the primary security layer for the web interface.
 */

import type { Handle, HandleServerError } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);

  // Strict Transport Security (1 year)
  response.headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  // Content Security Policy
  // connect-src allows WebSocket connections to any port on localhost/127.0.0.1
  // since the gateway port is user-configurable via Settings.
  // TODO: In production, add a `report-to` directive pointing at a CSP
  // violation reporting endpoint (e.g. report-uri.com or a self-hosted collector).
  const gatewayConnectSrc =
    process.env.EIDOLON_CSP_CONNECT_SRC ?? "ws://localhost:* wss://localhost:* ws://127.0.0.1:* wss://127.0.0.1:*";
  response.headers.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' ${gatewayConnectSrc}`,
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
  response.headers.set("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");

  // Prevent cross-domain content loading (Flash/PDF policies)
  response.headers.set("X-Permitted-Cross-Domain-Policies", "none");

  // Prevent DNS prefetch to avoid information leakage
  response.headers.set("X-DNS-Prefetch-Control", "off");

  return response;
};

/**
 * Server-side error handler — logs unhandled errors and returns
 * a sanitized message so internal details are never exposed to clients.
 */
export const handleError: HandleServerError = ({ error, status, message }) => {
  // Log the full error server-side for debugging
  const errMsg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  console.error(`[ERROR] [hooks.server] Unhandled server error (${status}):`, errMsg);
  if (stack) console.error(stack);

  // Sanitize: strip file paths and stack traces from the user-facing message
  let sanitized = errMsg
    .replace(/\/[^\s:]+\.[a-z]+/gi, "[path]")
    .replace(/[A-Z]:\\[^\s:]+\.[a-z]+/gi, "[path]")
    .replace(/\n\s+at\s+.*/g, "")
    .trim();
  if (!sanitized) sanitized = message;

  return { message: sanitized };
};
