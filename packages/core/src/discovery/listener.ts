/**
 * Network discovery listener -- client-side component.
 *
 * Listens for UDP broadcast beacons from Eidolon servers on port 41920.
 * Parses and optionally verifies HMAC-signed beacons, deduplicates
 * discovered servers, and emits events when servers appear or disappear.
 *
 * Usage:
 *   const listener = new DiscoveryListener({ logger });
 *   listener.onServerFound((record) => console.log("Found:", record));
 *   await listener.start();
 *   // ... later
 *   await listener.stop();
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { DiscoveryBeacon } from "@eidolon/protocol";
import { z } from "zod";
import type { Logger } from "../logging/logger.ts";
import type { SignedBeacon } from "./broadcaster.ts";
import { DISCOVERY_PORT } from "./broadcaster.ts";

// ---------------------------------------------------------------------------
// Zod schemas for beacon validation
// ---------------------------------------------------------------------------

const DiscoveryBeaconSchema = z.object({
  service: z.literal("eidolon"),
  version: z.string(),
  hostname: z.string(),
  host: z.string(),
  port: z.number(),
  tailscaleIp: z.string().optional(),
  tls: z.boolean(),
  role: z.literal("server"),
  startedAt: z.number(),
});

const SignedBeaconSchema = z.object({
  beacon: DiscoveryBeaconSchema,
  nonce: z.string(),
  hmac: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A discovered server record with metadata about when it was last seen. */
export interface DiscoveredServer {
  readonly hostname: string;
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly tailscaleIp?: string;
  readonly tls: boolean;
  readonly startedAt: number;
  /** Timestamp (ms) when this server was first discovered in this session. */
  readonly discoveredAt: number;
  /** Timestamp (ms) when the last beacon was received from this server. */
  lastSeenAt: number;
  /** Whether the beacon was HMAC-verified (true) or unsigned (false). */
  readonly verified: boolean;
}

export type ServerFoundHandler = (server: DiscoveredServer) => void;
export type ServerLostHandler = (server: DiscoveredServer) => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum age (ms) before a server is considered lost. Default: 3 beacon intervals. */
const SERVER_EXPIRY_MS = 20_000;

/** Interval (ms) to check for expired servers. */
const EXPIRY_CHECK_INTERVAL_MS = 5_000;

/** Maximum beacon payload size accepted (same as broadcaster). */
const MAX_BEACON_SIZE = 1024;

/** Maximum beacons per source IP within the rate limit window before dropping. */
const BEACON_RATE_LIMIT_MAX = 10;

/** Rate limit window in milliseconds. */
const BEACON_RATE_LIMIT_WINDOW_MS = 60_000;

// ---------------------------------------------------------------------------
// DiscoveryListener
// ---------------------------------------------------------------------------

export class DiscoveryListener {
  private readonly logger: Logger;
  private readonly beaconKey: string | null;

  private socket: Bun.udp.Socket<"buffer"> | null = null;
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly servers: Map<string, DiscoveredServer> = new Map();
  private readonly onFoundHandlers: Set<ServerFoundHandler> = new Set();
  private readonly onLostHandlers: Set<ServerLostHandler> = new Set();
  private readonly beaconTimestamps: Map<string, number[]> = new Map();

  constructor(deps: {
    logger: Logger;
    /** If provided, only verified (HMAC-signed) beacons are accepted. */
    beaconKey?: string;
  }) {
    this.logger = deps.logger.child("discovery-listener");
    this.beaconKey = deps.beaconKey || null;
  }

  /** Register a handler called when a new server is discovered. */
  onServerFound(handler: ServerFoundHandler): () => void {
    this.onFoundHandlers.add(handler);
    return () => {
      this.onFoundHandlers.delete(handler);
    };
  }

  /** Register a handler called when a server's beacons stop arriving. */
  onServerLost(handler: ServerLostHandler): () => void {
    this.onLostHandlers.add(handler);
    return () => {
      this.onLostHandlers.delete(handler);
    };
  }

  /** Get all currently known servers. */
  getServers(): ReadonlyArray<DiscoveredServer> {
    return [...this.servers.values()];
  }

  /** Start listening for UDP broadcast beacons. */
  async start(): Promise<void> {
    if (this.socket) {
      this.logger.warn("start", "Discovery listener already running");
      return;
    }

    try {
      const self = this;
      this.socket = await Bun.udpSocket({
        port: DISCOVERY_PORT,
        socket: {
          data(_sock, buf, _port, addr) {
            self.handleBeacon(buf, addr);
          },
        },
      });

      this.expiryTimer = setInterval(() => {
        this.pruneExpiredServers();
      }, EXPIRY_CHECK_INTERVAL_MS);
      this.expiryTimer.unref();

      this.logger.info("start", `Listening for discovery beacons on UDP port ${DISCOVERY_PORT}`);
    } catch (err) {
      this.logger.warn("start", "Failed to start discovery listener", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Stop listening and clean up. */
  async stop(): Promise<void> {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.servers.clear();
    this.beaconTimestamps.clear();
    this.logger.info("stop", "Discovery listener stopped");
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Handle an incoming UDP datagram that might be a beacon. */
  private handleBeacon(buf: Buffer, addr: string): void {
    if (buf.length > MAX_BEACON_SIZE) {
      this.logger.debug("beacon", "Oversized beacon dropped", { bytes: buf.length });
      return;
    }

    if (this.isBeaconRateLimited(addr)) {
      this.logger.debug("beacon", "Rate limited beacon dropped", { addr });
      return;
    }

    let text: string;
    try {
      text = buf.toString("utf-8");
    } catch {
      // Intentional: non-UTF8 beacon data is silently dropped
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Intentional: non-JSON beacon data is silently dropped
      return;
    }

    if (typeof parsed !== "object" || parsed === null) return;

    const obj = parsed as Record<string, unknown>;

    // Determine if this is a signed beacon or a plain beacon
    let beacon: DiscoveryBeacon;
    let verified = false;

    if ("beacon" in obj && "hmac" in obj && "nonce" in obj) {
      // Signed beacon -- validate with Zod
      const signedResult = SignedBeaconSchema.safeParse(obj);
      if (!signedResult.success) return;

      const signed = signedResult.data;

      if (this.beaconKey) {
        if (!verifyBeaconHmac(signed, this.beaconKey)) {
          this.logger.debug("beacon", "Beacon HMAC verification failed", { addr });
          return;
        }
        verified = true;
      }
      beacon = signed.beacon;
    } else {
      // Plain (unsigned) beacon -- validate with Zod
      const beaconResult = DiscoveryBeaconSchema.safeParse(obj);
      if (!beaconResult.success) return;

      // If we require verification, reject unsigned beacons
      if (this.beaconKey) {
        this.logger.debug("beacon", "Unsigned beacon rejected (key configured)", { addr });
        return;
      }
      beacon = beaconResult.data;
    }

    this.processBeacon(beacon, addr, verified);
  }

  private isBeaconRateLimited(addr: string): boolean {
    const now = Date.now();
    const timestamps = this.beaconTimestamps.get(addr);

    if (!timestamps) {
      this.beaconTimestamps.set(addr, [now]);
      return false;
    }

    const recent = timestamps.filter((t) => now - t < BEACON_RATE_LIMIT_WINDOW_MS);
    recent.push(now);
    this.beaconTimestamps.set(addr, recent);

    // Periodically prune stale IP entries to prevent unbounded map growth
    for (const [ip, ts] of this.beaconTimestamps) {
      if (ip === addr) continue;
      const recentTs = ts.filter((t) => now - t < BEACON_RATE_LIMIT_WINDOW_MS);
      if (recentTs.length === 0) {
        this.beaconTimestamps.delete(ip);
      } else if (recentTs.length !== ts.length) {
        this.beaconTimestamps.set(ip, recentTs);
      }
    }

    return recent.length > BEACON_RATE_LIMIT_MAX;
  }

  /** Process a validated beacon and update the server list. */
  private processBeacon(beacon: DiscoveryBeacon, addr: string, verified: boolean): void {
    // Use host:port as the unique key for a server
    const key = `${beacon.host}:${beacon.port}`;
    const now = Date.now();

    const existing = this.servers.get(key);
    if (existing) {
      // Update last-seen timestamp
      existing.lastSeenAt = now;
      return;
    }

    // New server discovered
    const record: DiscoveredServer = {
      hostname: beacon.hostname,
      host: beacon.host,
      port: beacon.port,
      version: beacon.version,
      ...(beacon.tailscaleIp ? { tailscaleIp: beacon.tailscaleIp } : {}),
      tls: beacon.tls,
      startedAt: beacon.startedAt,
      discoveredAt: now,
      lastSeenAt: now,
      verified,
    };

    this.servers.set(key, record);
    this.logger.info("found", `Discovered server: ${beacon.hostname} at ${beacon.host}:${beacon.port}`, {
      version: beacon.version,
      tls: beacon.tls,
      verified,
      addr,
    });

    for (const handler of [...this.onFoundHandlers]) {
      try {
        handler(record);
      } catch (err) {
        this.logger.error("handler", "onServerFound handler error", err);
      }
    }
  }

  /** Remove servers that haven't sent a beacon recently. */
  private pruneExpiredServers(): void {
    const now = Date.now();
    for (const [key, server] of this.servers) {
      if (now - server.lastSeenAt > SERVER_EXPIRY_MS) {
        this.servers.delete(key);
        this.logger.info("lost", `Server lost: ${server.hostname} at ${server.host}:${server.port}`);

        for (const handler of [...this.onLostHandlers]) {
          try {
            handler(server);
          } catch (err) {
            this.logger.error("handler", "onServerLost handler error", err);
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HMAC verification
// ---------------------------------------------------------------------------

/**
 * Verify the HMAC signature on a signed beacon.
 * Uses constant-time comparison to prevent timing attacks.
 */
function verifyBeaconHmac(signed: SignedBeacon, key: string): boolean {
  if (typeof signed.nonce !== "string" || typeof signed.hmac !== "string") return false;

  const beaconJson = JSON.stringify(signed.beacon);
  const expected = createHmac("sha256", key)
    .update(beaconJson + signed.nonce)
    .digest("hex");

  if (expected.length !== signed.hmac.length) return false;

  const bufExpected = Buffer.from(expected, "utf-8");
  const bufActual = Buffer.from(signed.hmac, "utf-8");
  return timingSafeEqual(bufExpected, bufActual);
}
