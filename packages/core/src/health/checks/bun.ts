/**
 * Health check: Bun runtime version.
 *
 * Verifies that the Bun runtime version is >= 1.0.
 */

import type { HealthCheck } from "@eidolon/protocol";

const MIN_MAJOR_VERSION = 1;

/** Create a health check that verifies the Bun runtime version. */
export function createBunCheck(): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => {
    const version = Bun.version;
    const major = Number.parseInt(version.split(".")[0] ?? "0", 10);

    if (major >= MIN_MAJOR_VERSION) {
      return { name: "bun", status: "pass", message: `Bun v${version}` };
    }

    return {
      name: "bun",
      status: "fail",
      message: `Bun v${version} is below minimum required v${MIN_MAJOR_VERSION}.0`,
    };
  };
}
