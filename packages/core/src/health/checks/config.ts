/**
 * Health check: configuration file validity.
 *
 * Verifies the config file exists and contains valid JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import type { HealthCheck } from "@eidolon/protocol";

/** Create a health check that validates a config file at `configPath`. */
export function createConfigCheck(configPath: string): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => {
    if (!existsSync(configPath)) {
      return {
        name: "config",
        status: "warn",
        message: `Config file not found: ${configPath}`,
      };
    }

    try {
      const content = readFileSync(configPath, "utf-8");
      JSON.parse(content) as unknown;
      return { name: "config", status: "pass", message: "Config file valid" };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { name: "config", status: "fail", message: `Invalid config: ${message}` };
    }
  };
}
