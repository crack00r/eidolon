/**
 * Helper functions, constants, and internal types for the Gateway server.
 *
 * Extracted from server.ts (P1-26) to keep the server module focused
 * on WebSocket lifecycle and connection management.
 */

import { timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export type MethodHandler = (params: Record<string, unknown>, clientId: string) => Promise<unknown>;

/** Minimal interface for the server-side WebSocket, matching Bun.ServerWebSocket. */
export interface ServerWS {
  readonly data: WSData;
  send(data: string | ArrayBuffer | Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
}

export interface ClientState {
  readonly id: string;
  readonly ip: string;
  readonly ws: ServerWS;
  authenticated: boolean;
  /** Client-reported platform identifier (e.g., "desktop", "web", "ios"). */
  platform: string;
  /** Client-reported version string. */
  version: string;
  /** Timestamp (ms) when the WebSocket connection was established. */
  readonly connectedAt: number;
  /** SEC-M4: Per-message rate limiting state. */
  messageCount: number;
  messageWindowStart: number;
}

export interface WSData {
  clientId: string;
  ip: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout in ms for unauthenticated clients before disconnection. */
export const AUTH_TIMEOUT_MS = 10_000;

/**
 * SEC-M4: Per-message rate limiting for authenticated clients.
 * Maximum RPC messages per second per client to prevent flooding.
 */
export const MAX_MESSAGES_PER_SECOND = 50;

/** Sliding window duration in ms for per-message rate limiting. */
export const MESSAGE_RATE_WINDOW_MS = 1_000;

/** WebSocket idle timeout in seconds (Bun uses seconds for this). */
export const WS_IDLE_TIMEOUT_SECONDS = 120;

/** Standard security headers applied to all HTTP responses from the gateway. */
export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "0",
  "Cache-Control": "no-store",
  "Content-Type": "text/plain",
  "Content-Security-Policy": "default-src 'none'",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison to prevent timing attacks on token validation.
 * When lengths differ, compare the secret (b) against itself to avoid leaking
 * attacker-controlled timing information while preserving constant-time behavior.
 */
export function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    // Compare secret against itself (not attacker input) to prevent timing leak
    timingSafeEqual(bufB, bufB);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Normalize IP address: strip IPv4-mapped IPv6 prefix (::ffff:) to prevent bypass.
 */
export function normalizeIp(ip: string): string {
  if (ip.startsWith("::ffff:")) return ip.slice(7);
  return ip;
}

/**
 * Anonymize an IP address for GDPR-compliant logging.
 * IPv4: replace last octet with 0 (e.g., 192.168.1.42 -> 192.168.1.0)
 * IPv6: truncate last 80 bits (keep first 48 bits, zero the rest)
 */
export function anonymizeIp(ip: string): string {
  // IPv4: a.b.c.d -> a.b.c.0
  if (ip.includes(".") && !ip.includes(":")) {
    const lastDot = ip.lastIndexOf(".");
    if (lastDot === -1) return ip;
    return `${ip.slice(0, lastDot)}.0`;
  }
  // IPv6: expand compressed form, keep first 3 groups (48 bits), zero the rest
  // Short addresses like "::1" have fewer than 3 non-empty groups -- return as-is
  // since they don't contain personally identifiable information
  const nonEmptyParts = ip.split(":").filter((p) => p.length > 0);
  if (nonEmptyParts.length < 3) {
    return ip;
  }
  return `${nonEmptyParts.slice(0, 3).join(":")}::`;
}

/**
 * Normalize an origin string for comparison: lowercase and strip trailing slash.
 */
export function normalizeOrigin(origin: string): string {
  return origin.toLowerCase().replace(/\/+$/, "");
}

/** Create an HTTP Response with security headers, optionally adding HSTS for TLS. */
export function secureResponse(body: string, status: number, tlsEnabled?: boolean): Response {
  const headers = { ...SECURITY_HEADERS };
  // Finding #11: Add HSTS header when TLS is enabled
  if (tlsEnabled) {
    headers["Strict-Transport-Security"] = "max-age=31536000";
  }
  return new Response(body, { status, headers });
}
