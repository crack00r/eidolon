/**
 * Pairing URL and token generation for client connection.
 *
 * Generates eidolon:// URLs that clients can use to connect,
 * as well as machine-readable JSON for QR code generation.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { GatewayConfig, PairingUrl } from "@eidolon/protocol";
import { VERSION } from "@eidolon/protocol";
import { getLocalIpAddresses } from "./broadcaster.ts";
import type { TailscaleDetector } from "./tailscale.ts";

// ---------------------------------------------------------------------------
// Token generation
// ---------------------------------------------------------------------------

/** Generate a cryptographically random auth token (URL-safe base64, 32 bytes). */
export function generateAuthToken(): string {
  return randomBytes(32).toString("base64url");
}

// ---------------------------------------------------------------------------
// Pairing URL
// ---------------------------------------------------------------------------

/**
 * Build a pairing URL from the current gateway configuration.
 * Format: eidolon://<host>:<port>?token=<auth_token>&tls=<bool>
 */
export function buildPairingUrl(config: GatewayConfig, tailscale?: TailscaleDetector): PairingUrl {
  const addresses = getLocalIpAddresses();
  const host = config.host === "0.0.0.0" || config.host === "::"
    ? addresses[0] ?? "127.0.0.1"
    : config.host;
  const token = typeof config.auth.token === "string" ? config.auth.token : "";
  const tls = config.tls.enabled;
  const tailscaleIp = tailscale?.getCachedIp();

  const params = new URLSearchParams();
  params.set("token", token);
  params.set("tls", String(tls));
  if (tailscaleIp) {
    params.set("tailscale", tailscaleIp);
  }
  params.set("v", VERSION);

  const url = `eidolon://${host}:${config.port}?${params.toString()}`;

  return {
    url,
    host,
    port: config.port,
    token,
    tls,
    ...(tailscaleIp ? { tailscaleIp } : {}),
    version: VERSION,
  };
}

/**
 * Build machine-readable JSON suitable for QR code encoding.
 */
export function buildPairingJson(config: GatewayConfig, tailscale?: TailscaleDetector): string {
  const pairing = buildPairingUrl(config, tailscale);
  return JSON.stringify({
    host: pairing.host,
    port: pairing.port,
    token: pairing.token,
    tls: pairing.tls,
    ...(pairing.tailscaleIp ? { tailscaleIp: pairing.tailscaleIp } : {}),
    version: pairing.version,
    hostname: hostname(),
  }, null, 2);
}

/**
 * Format connection details as a human-readable table.
 */
export function formatConnectionDetails(config: GatewayConfig, tailscale?: TailscaleDetector): string {
  const pairing = buildPairingUrl(config, tailscale);
  const lines: string[] = [
    "",
    "  Connection Details",
    "  " + "=".repeat(40),
    `  Host:         ${pairing.host}`,
    `  Port:         ${pairing.port}`,
    `  TLS:          ${pairing.tls ? "enabled" : "disabled"}`,
    `  Version:      ${pairing.version}`,
  ];

  if (pairing.tailscaleIp) {
    lines.push(`  Tailscale IP: ${pairing.tailscaleIp}`);
  }

  lines.push("");
  lines.push(`  Pairing URL:  ${pairing.url}`);
  lines.push("");

  return lines.join("\n");
}
