/**
 * Desktop client network discovery -- finds Eidolon servers on the local network.
 *
 * Listens for UDP broadcast beacons on port 41920 and returns discovered
 * servers. Used by the connection store to auto-connect when no manual
 * host is configured.
 *
 * In environments where UDP broadcast is not available (e.g., WebView sandbox),
 * falls back to a manual HTTP probe at well-known addresses.
 */

import { clientLog } from "./logger";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time (ms) to wait during a discovery scan. */
const DEFAULT_SCAN_TIMEOUT_MS = 6_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A discovered Eidolon server on the local network. */
export interface DiscoveredServer {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly tailscaleIp?: string;
  readonly tls: boolean;
}

/** Beacon payload broadcast by the server (matches @eidolon/protocol DiscoveryBeacon). */
interface BeaconPayload {
  readonly service: string;
  readonly version: string;
  readonly hostname: string;
  readonly host: string;
  readonly port: number;
  readonly tailscaleIp?: string;
  readonly tls: boolean;
  readonly role: string;
  readonly startedAt: number;
}

/** Signed beacon wrapper (when HMAC signing is configured on the server). */
interface SignedBeaconPayload {
  readonly beacon: BeaconPayload;
  readonly nonce: string;
  readonly hmac: string;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isValidBeacon(obj: unknown): obj is BeaconPayload {
  if (typeof obj !== "object" || obj === null) return false;
  const b = obj as Record<string, unknown>;
  return (
    b.service === "eidolon" &&
    typeof b.version === "string" &&
    typeof b.hostname === "string" &&
    typeof b.host === "string" &&
    typeof b.port === "number" &&
    typeof b.tls === "boolean" &&
    b.role === "server" &&
    typeof b.startedAt === "number"
  );
}

function extractBeacon(parsed: unknown): BeaconPayload | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;

  // Check if it's a signed beacon
  if ("beacon" in obj && "hmac" in obj && "nonce" in obj) {
    const signed = obj as unknown as SignedBeaconPayload;
    if (isValidBeacon(signed.beacon)) {
      return signed.beacon;
    }
    return null;
  }

  // Plain beacon
  if (isValidBeacon(obj)) {
    return obj as unknown as BeaconPayload;
  }

  return null;
}

// ---------------------------------------------------------------------------
// HTTP fallback probe
// ---------------------------------------------------------------------------

/**
 * Probe a specific host for the Eidolon health endpoint.
 * Returns a DiscoveredServer if the host responds, or null.
 */
async function probeHost(host: string, port: number, timeoutMs: number): Promise<DiscoveredServer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `http://${host}:${port}/health`;
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return null;
    const obj = data as Record<string, unknown>;

    return {
      name: typeof obj.hostname === "string" ? obj.hostname : host,
      host,
      port,
      version: typeof obj.version === "string" ? obj.version : "unknown",
      tls: false,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover Eidolon servers on the local network.
 *
 * Uses UDP broadcast listening as the primary mechanism. If the Tauri WebView
 * does not expose raw UDP (likely), falls back to probing well-known addresses.
 *
 * @param timeoutMs - Maximum scan duration in milliseconds.
 * @param fallbackHosts - Hosts to probe via HTTP if UDP is unavailable.
 * @returns Array of discovered servers (may be empty).
 */
export async function discoverServers(
  timeoutMs: number = DEFAULT_SCAN_TIMEOUT_MS,
  fallbackHosts: string[] = ["127.0.0.1", "localhost"],
): Promise<DiscoveredServer[]> {
  clientLog("info", "discovery", "Starting server discovery scan");

  const servers = new Map<string, DiscoveredServer>();

  // Strategy 1: Try UDP broadcast listening via Tauri plugin or WebSocket proxy.
  // In a Tauri context, raw UDP sockets require a plugin. If the invoke fails,
  // we fall back to HTTP probing.
  const udpServers = await tryUdpDiscovery(timeoutMs);
  for (const s of udpServers) {
    servers.set(`${s.host}:${s.port}`, s);
  }

  // Strategy 2: HTTP health endpoint probing (always attempted as a supplement)
  const probePromises = fallbackHosts.map((host) =>
    probeHost(host, 8419, Math.min(timeoutMs, 3000)),
  );
  const probeResults = await Promise.allSettled(probePromises);
  for (const result of probeResults) {
    if (result.status === "fulfilled" && result.value) {
      const s = result.value;
      const key = `${s.host}:${s.port}`;
      if (!servers.has(key)) {
        servers.set(key, s);
      }
    }
  }

  const results = [...servers.values()];
  clientLog("info", "discovery", `Discovery complete: found ${results.length} server(s)`, {
    servers: results.map((s) => `${s.name}@${s.host}:${s.port}`),
  });

  return results;
}

/**
 * Attempt UDP broadcast discovery via Tauri's invoke mechanism.
 *
 * Tauri apps communicate with their Rust backend via `invoke()`. If the
 * desktop app has a Rust plugin for UDP socket listening, this will use it.
 * Otherwise, it returns an empty array gracefully.
 */
async function tryUdpDiscovery(timeoutMs: number): Promise<DiscoveredServer[]> {
  try {
    // Check if Tauri's invoke API is available
    if (typeof window === "undefined" || !("__TAURI__" in window)) {
      clientLog("debug", "discovery", "Tauri API not available, skipping UDP discovery");
      return [];
    }

    const tauri = (window as Record<string, unknown>).__TAURI__ as Record<string, unknown> | undefined;
    if (!tauri) return [];

    // Attempt to invoke a Rust-side discovery command
    const invoke = (tauri.core as Record<string, unknown> | undefined)?.invoke as
      | ((cmd: string, args: Record<string, unknown>) => Promise<unknown>)
      | undefined;

    if (typeof invoke !== "function") {
      clientLog("debug", "discovery", "Tauri invoke not available, skipping UDP discovery");
      return [];
    }

    const result: unknown = await invoke("discover_servers", {
      timeoutMs,
    });

    if (!Array.isArray(result)) return [];

    const servers: DiscoveredServer[] = [];
    for (const item of result) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;

      // First try parsing as a beacon (matching the protocol's DiscoveryBeacon shape)
      const beacon = extractBeacon(obj);
      if (beacon) {
        servers.push({
          name: beacon.hostname,
          host: beacon.host,
          port: beacon.port,
          version: beacon.version,
          ...(beacon.tailscaleIp ? { tailscaleIp: beacon.tailscaleIp } : {}),
          tls: beacon.tls,
        });
        continue;
      }

      // Fall back to Rust DiscoveredServer struct shape:
      // { service, version, host, port, hostname, name, tailscaleIp, tls }
      if (
        typeof obj.host === "string" &&
        typeof obj.port === "number" &&
        typeof obj.service === "string"
      ) {
        servers.push({
          name: typeof obj.name === "string" ? obj.name : (typeof obj.hostname === "string" ? obj.hostname : obj.host),
          host: obj.host,
          port: obj.port,
          version: typeof obj.version === "string" ? obj.version : "unknown",
          ...(typeof obj.tailscaleIp === "string" ? { tailscaleIp: obj.tailscaleIp } : {}),
          tls: typeof obj.tls === "boolean" ? obj.tls : false,
        });
      }
    }

    return servers;
  } catch (err) {
    clientLog("debug", "discovery", "UDP discovery not available", err);
    return [];
  }
}
