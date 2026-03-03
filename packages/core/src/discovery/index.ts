// Discovery -- network discovery, Tailscale integration, and pairing

export type { SignedBeacon } from "./broadcaster.ts";
export { DISCOVERY_PORT, DiscoveryBroadcaster, getLocalIpAddresses } from "./broadcaster.ts";
export type { DiscoveredServer, ServerFoundHandler, ServerLostHandler } from "./listener.ts";
export { DiscoveryListener } from "./listener.ts";
export { buildPairingJson, buildPairingUrl, formatConnectionDetails, generateAuthToken } from "./pairing.ts";
export type { TailscaleInfo } from "./tailscale.ts";
export { TailscaleDetector } from "./tailscale.ts";
