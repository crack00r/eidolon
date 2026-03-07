/**
 * Client-mode onboard flow: discover and connect to an existing brain server.
 * Extracted from onboard.ts to keep files under 300 lines.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { getConfigDir, getConfigPath } from "@eidolon/core";
import type { AskFn } from "./onboard-steps.ts";

// ---------------------------------------------------------------------------
// Client onboard flow
// ---------------------------------------------------------------------------

export async function onboardClient(ask: AskFn): Promise<void> {
  console.log("\n--- Searching for Eidolon servers... ---\n");
  console.log("  Listening for broadcast beacons (5 seconds)...");

  const servers = await discoverServers();
  let host: string | undefined;
  let port = 8419;
  let token = "";
  let tls = false;

  if (servers.length > 0) {
    for (let i = 0; i < servers.length; i++) {
      const s = servers[i];
      if (!s) continue;
      const via = s.tailscaleIp ? " (tailscale)" : " (local)";
      console.log(`  [${i + 1}] "${s.hostname}" at ${s.host}:${s.port}${via}`);
    }
    const selInput = await ask("\nSelect server [1]: ");
    const selIdx = (Number.parseInt(selInput, 10) || 1) - 1;
    const selected = servers[selIdx];
    if (selected) {
      host = selected.tailscaleIp ?? selected.host;
      port = selected.port;
      console.log(`\n  Selected: ${host}:${port}`);
      token = await ask("Auth token: ");
    }
  }

  if (!host) {
    if (servers.length === 0) console.log("  No servers found via broadcast.");
    const manual = await ask("\nEnter server address manually (host:port): ");
    if (manual) {
      const parts = manual.split(":");
      host = parts[0] ?? manual;
      if (parts.length > 1) port = Number.parseInt(parts[1] ?? "8419", 10) || 8419;
      token = await ask("Auth token: ");
    }
  }

  if (!host) {
    console.log("  No server configured. Run 'eidolon onboard' again when ready.");
    return;
  }

  const tlsChoice = await ask("Server uses TLS? [y/N]: ");
  tls = tlsChoice.toLowerCase() === "y";

  writeClientConfig(host, port, token, tls);
  await testConnection(host, port, tls);

  console.log("\n--- Setup Complete ---\n");
  console.log(`  Server:  ${tls ? "wss" : "ws"}://${host}:${port}`);
  console.log(`  Config:  ${getConfigPath()}`);
  console.log("\nNext steps:");
  console.log("  1. Open the Desktop, iOS, or Web app");
  console.log("  2. Or run 'eidolon chat' for CLI interaction");
  console.log();
}

// ---------------------------------------------------------------------------
// Client helpers
// ---------------------------------------------------------------------------

interface DiscoveredServer {
  hostname: string;
  host: string;
  port: number;
  tailscaleIp?: string;
}

async function discoverServers(): Promise<DiscoveredServer[]> {
  const servers: DiscoveredServer[] = [];
  try {
    const { DISCOVERY_PORT } = await import("@eidolon/core");
    const socket = await Bun.udpSocket({
      port: DISCOVERY_PORT,
      socket: {
        data(_socket, buf, _port, _addr) {
          try {
            const text = Buffer.from(buf).toString("utf-8");
            const parsed: unknown = JSON.parse(text);
            if (typeof parsed === "object" && parsed !== null) {
              const obj = parsed as Record<string, unknown>;
              if (obj.service === "eidolon") {
                servers.push({
                  hostname: String(obj.hostname ?? "unknown"),
                  host: String(obj.host ?? ""),
                  port: Number(obj.port ?? 8419),
                  ...(typeof obj.tailscaleIp === "string" ? { tailscaleIp: obj.tailscaleIp } : {}),
                });
              }
            }
          } catch {
            /* ignore malformed packets */
          }
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    socket.close();
  } catch {
    // UDP socket not available
  }
  return servers;
}

function writeClientConfig(host: string, port: number, token: string, tls: boolean): void {
  const configPath = getConfigPath();
  const configDir = getConfigDir();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  const config = { role: "client", server: { host, port, token, tls }, logging: { level: "info", format: "pretty" } };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  if (process.platform !== "win32") chmodSync(configPath, 0o600);
  console.log(`\n  Client config written to: ${configPath} (mode 0600)`);
}

async function testConnection(host: string, port: number, tls: boolean): Promise<void> {
  console.log("\n--- Testing connection... ---\n");
  const protocol = tls ? "https" : "http";
  try {
    const resp = await fetch(`${protocol}://${host}:${port}/health`, { signal: AbortSignal.timeout(3000) });
    if (resp.ok) {
      const data = (await resp.json()) as Record<string, unknown>;
      console.log(`  Server is reachable! Status: ${String(data.status ?? "unknown")}`);
    } else {
      console.log(`  Server responded with HTTP ${resp.status}. It may still work.`);
    }
  } catch {
    console.log("  Could not reach health endpoint. Server may not be running yet.");
  }
}
