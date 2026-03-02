// Discovery -- network discovery, Tailscale integration, and pairing

export { DISCOVERY_PORT, DiscoveryBroadcaster, getLocalIpAddresses } from "./broadcaster.ts";
export { buildPairingJson, buildPairingUrl, formatConnectionDetails, generateAuthToken } from "./pairing.ts";
export type { TailscaleInfo } from "./tailscale.ts";
export { TailscaleDetector } from "./tailscale.ts";
