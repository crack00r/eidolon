/**
 * Network setup helpers for onboarding.
 *
 * Generates auth tokens, builds gateway config, and detects Tailscale.
 */

import { randomBytes } from "node:crypto";

export function generateAuthToken(): string {
  return randomBytes(32).toString("hex");
}

export interface GatewayBuildOptions {
  readonly port: number;
  readonly token: string;
  readonly tailscaleIp: string | undefined;
}

export interface GatewayConfig {
  readonly port: number;
  readonly host: string;
  readonly auth: { readonly type: "token"; readonly token: string };
  readonly tls: { readonly enabled: boolean };
  readonly discovery: { readonly enabled: boolean; readonly port: number };
}

export function buildGatewayConfig(options: GatewayBuildOptions): GatewayConfig {
  return {
    port: options.port,
    host: options.tailscaleIp ? "0.0.0.0" : "127.0.0.1",
    auth: { type: "token" as const, token: options.token },
    tls: { enabled: false },
    discovery: { enabled: !!options.tailscaleIp, port: 41920 },
  };
}

export async function detectTailscale(): Promise<string | null> {
  try {
    const proc = Bun.spawn(["tailscale", "ip", "-4"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    const ip = output.trim().split("\n")[0]?.trim();
    return ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
  } catch {
    return null;
  }
}
