// Onboarding module -- shared setup logic for Desktop GUI and CLI.

export type { PreflightResult } from "./setup-checks.ts";
export { runPreflightChecks } from "./setup-checks.ts";

export { getDefaultOwnerName } from "./setup-identity.ts";

// generateMasterKey is re-exported from secrets/index.ts
// generateAuthToken is re-exported from discovery/index.ts

export type { DbInitResult } from "./setup-database.ts";
export { initializeDatabases } from "./setup-database.ts";
export type { ClientConfigInput, ServerConfigInput } from "./setup-finalize.ts";
export {
  buildClientConfig,
  buildServerConfig,
  writeConfig,
} from "./setup-finalize.ts";
export type { GatewayBuildOptions, GatewayConfig } from "./setup-network.ts";
export {
  buildGatewayConfig,
  detectTailscale,
} from "./setup-network.ts";
