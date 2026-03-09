/**
 * Network discovery via UDP broadcast beacons.
 *
 * The server periodically sends a JSON beacon on UDP broadcast (port 41920).
 * Clients listen on the same port to auto-discover servers on the LAN.
 * Also attempts mDNS advertisement via platform-native tools
 * (dns-sd on macOS, avahi-publish on Linux).
 *
 * SECURITY NOTE (NET-002/003): UDP beacons are inherently unauthenticated and
 * can be spoofed by any device on the local network. When a beacon signing key
 * is provided, beacons include an HMAC-SHA256 signature so receivers can verify
 * authenticity. Without a key (e.g., pre-pairing), beacons are unsigned and
 * MUST NOT be trusted for security-critical decisions.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

/** Signed beacon payload sent over UDP, wrapping the base beacon with HMAC authentication. */
export interface SignedBeacon {
  readonly beacon: DiscoveryBeacon;
  readonly nonce: string;
  readonly hmac: string;
}

export class DiscoveryBroadcaster {
  private readonly logger: Logger;
  private readonly gatewayPort: number;
  private readonly tlsEnabled: boolean;
  private readonly tailscale: TailscaleDetector | null;
  private readonly beaconKey: string | null;
  private readonly startedAt: number;

  private broadcastTimer: ReturnType<typeof setInterval> | null = null;
  private socket: Bun.udp.Socket<"buffer"> | null = null;
  private mdnsProcess: ReturnType<typeof Bun.spawn> | null = null;

  constructor(deps: {
    logger: Logger;
    gatewayPort: number;
    tlsEnabled: boolean;
    tailscale?: TailscaleDetector;
    /** Key used to HMAC-sign beacons. If omitted, beacons are sent unsigned. */
    beaconKey?: string;
  }) {
    this.logger = deps.logger.child("discovery");
    this.gatewayPort = deps.gatewayPort;
    this.tlsEnabled = deps.tlsEnabled;
    this.tailscale = deps.tailscale ?? null;
    this.beaconKey = deps.beaconKey || null;
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

      if (!this.beaconKey) {
        this.logger.debug(
          "start",
          "No beacon signing key configured — beacons are unsigned and can be spoofed on the local network",
        );
      }

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

  /**
   * Sign a beacon payload with HMAC-SHA256.
   *
   * The HMAC is computed over `JSON(beacon) + nonce` using the beacon key.
   * Receivers must verify this HMAC before trusting beacon data.
   */
  signBeacon(beacon: DiscoveryBeacon): SignedBeacon {
    if (!this.beaconKey) {
      throw new Error("Cannot sign beacon without a key");
    }
    const nonce = randomBytes(16).toString("hex");
    const beaconJson = JSON.stringify(beacon);
    const hmac = createHmac("sha256", this.beaconKey)
      .update(beaconJson + nonce)
      .digest("hex");
    return { beacon, nonce, hmac };
  }

  /**
   * Verify a signed beacon's HMAC using the provided key.
   * Returns true if the HMAC is valid, false otherwise.
   */
  static verifyBeacon(signed: SignedBeacon, key: string): boolean {
    const beaconJson = JSON.stringify(signed.beacon);
    const expected = createHmac("sha256", key)
      .update(beaconJson + signed.nonce)
      .digest("hex");
    // Constant-time comparison to prevent timing attacks
    if (expected.length !== signed.hmac.length) return false;
    const bufExpected = Buffer.from(expected, "utf-8");
    const bufActual = Buffer.from(signed.hmac, "utf-8");
    return timingSafeEqual(bufExpected, bufActual);
  }

  /** Send a beacon via UDP broadcast. */
  private async sendBeacon(): Promise<void> {
    if (!this.socket) return;

    try {
      const beacon = this.buildBeacon();
      // NET-002/003: Sign beacon with HMAC if a key is available
      const envelope = this.beaconKey ? this.signBeacon(beacon) : beacon;
      const payload = JSON.stringify(envelope);

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
      } else if (process.platform === "win32") {
        // Windows: no native mDNS tool available.
        // Discovery relies on UDP broadcast (port 41920) and HTTP /discovery endpoint (port 9419).
        this.logger.info("mdns", "mDNS not available on Windows; using UDP broadcast + HTTP discovery");
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
