/**
 * Network discovery via UDP broadcast beacons.
 *
 * The server periodically sends a JSON beacon on UDP broadcast (port 41920).
 * Clients listen on the same port to auto-discover servers on the LAN.
 * Also attempts mDNS advertisement via platform-native tools
 * (dns-sd on macOS, avahi-publish on Linux).
 */

import { hostname, networkInterfaces } from "node:os";
import type { DiscoveryBeacon } from "@eidolon/protocol";
import { VERSION } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { TailscaleDetector } from "./tailscale.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** UDP broadcast port for Eidolon discovery beacons. */
export const DISCOVERY_PORT = 41920;

/** Beacon broadcast interval in milliseconds. */
const BEACON_INTERVAL_MS = 5_000;

/** Maximum beacon payload size in bytes. */
const MAX_BEACON_SIZE = 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get all non-internal IPv4 addresses from network interfaces. */
export function getLocalIpAddresses(): string[] {
  const ifaces = networkInterfaces();
  const addresses: string[] = [];
  for (const [, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
}

// ---------------------------------------------------------------------------
// DiscoveryBroadcaster
// ---------------------------------------------------------------------------

export class DiscoveryBroadcaster {
  private readonly logger: Logger;
  private readonly gatewayPort: number;
  private readonly tlsEnabled: boolean;
  private readonly tailscale: TailscaleDetector | null;
  private readonly startedAt: number;

  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private socket: Bun.udp.Socket<"buffer"> | null = null;
  private mdnsProcess: ReturnType<typeof Bun.spawn> | null = null;

  constructor(deps: {
    logger: Logger;
    gatewayPort: number;
    tlsEnabled: boolean;
    tailscale?: TailscaleDetector;
  }) {
    this.logger = deps.logger.child("discovery");
    this.gatewayPort = deps.gatewayPort;
    this.tlsEnabled = deps.tlsEnabled;
    this.tailscale = deps.tailscale ?? null;
    this.startedAt = Date.now();
  }

  /** Start broadcasting discovery beacons. */
  async start(): Promise<void> {
    try {
      this.socket = await Bun.udpSocket({
        port: 0, // ephemeral port for sending
        socket: {
          data(_sock, _buf, _port, _addr) {
            // Ignore incoming data on this socket
          },
        },
      });
      this.socket.setBroadcast(true);

      this.broadcastTimer = setInterval(() => {
        void this.sendBeacon();
      }, BEACON_INTERVAL_MS);
      this.broadcastTimer.unref();

      // Send initial beacon immediately
      await this.sendBeacon();

      // Start platform-specific mDNS advertisement
      this.startMdns();

      this.logger.info("start", `Broadcasting on UDP port ${DISCOVERY_PORT}`);
    } catch (err) {
      this.logger.warn("start", "Failed to start discovery broadcaster", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Stop broadcasting and clean up. */
  async stop(): Promise<void> {
    if (this.broadcastTimer) {
      clearInterval(this.broadcastTimer);
      this.broadcastTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.stopMdns();
    this.logger.info("stop", "Discovery broadcaster stopped");
  }

  /** Build the current beacon payload. */
  buildBeacon(): DiscoveryBeacon {
    const addresses = getLocalIpAddresses();
    const host = addresses[0] ?? "127.0.0.1";
    const tailscaleIp = this.tailscale?.getCachedIp();

    return {
      service: "eidolon",
      version: VERSION,
      hostname: hostname(),
      host,
      port: this.gatewayPort,
      ...(tailscaleIp ? { tailscaleIp } : {}),
      tls: this.tlsEnabled,
      role: "server",
      startedAt: this.startedAt,
    };
  }

  /** Send a beacon via UDP broadcast. */
  private async sendBeacon(): Promise<void> {
    if (!this.socket) return;

    try {
      const beacon = this.buildBeacon();
      const payload = JSON.stringify(beacon);

      if (payload.length > MAX_BEACON_SIZE) {
        this.logger.warn("beacon", "Beacon payload exceeds max size, skipping");
        return;
      }

      const data = Buffer.from(payload, "utf-8");
      this.socket.send(data, DISCOVERY_PORT, "255.255.255.255");
    } catch (err) {
      this.logger.debug("beacon", "Beacon send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Start platform-native mDNS advertisement. */
  private startMdns(): void {
    try {
      if (process.platform === "darwin") {
        // macOS: dns-sd built-in
        this.mdnsProcess = Bun.spawn(
          ["dns-sd", "-R", "Eidolon Brain", "_eidolon._tcp.", ".", String(this.gatewayPort)],
          { stdout: "ignore", stderr: "ignore" },
        );
        this.mdnsProcess.unref();
        this.logger.debug("mdns", "Started dns-sd advertisement");
      } else if (process.platform === "linux") {
        // Linux: avahi-publish if available
        this.mdnsProcess = Bun.spawn(
          ["avahi-publish-service", "Eidolon Brain", "_eidolon._tcp", String(this.gatewayPort)],
          { stdout: "ignore", stderr: "ignore" },
        );
        this.mdnsProcess.unref();
        this.logger.debug("mdns", "Started avahi-publish-service advertisement");
      }
    } catch {
      this.logger.debug("mdns", "mDNS advertisement not available on this platform");
    }
  }

  /** Stop platform-native mDNS advertisement. */
  private stopMdns(): void {
    if (this.mdnsProcess) {
      try {
        this.mdnsProcess.kill();
      } catch {
        // Already exited
      }
      this.mdnsProcess = null;
    }
  }
}
