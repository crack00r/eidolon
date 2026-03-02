/**
 * Health check: database connectivity.
 *
 * Calls DatabaseManager.getStats() to verify all 3 databases are accessible.
 */

import type { HealthCheck } from "@eidolon/protocol";
import type { DatabaseManager } from "../../database/manager.ts";

/** Create a health check that verifies all databases are accessible. */
export function createDatabaseCheck(dbManager: DatabaseManager): () => Promise<HealthCheck> {
  return async (): Promise<HealthCheck> => {
    try {
      const stats = dbManager.getStats();
      const totalTables = stats.memory.tableCount + stats.operational.tableCount + stats.audit.tableCount;

      return {
        name: "databases",
        status: "pass",
        message: `All databases accessible (${totalTables} tables)`,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        name: "databases",
        status: "fail",
        message: `Database access failed: ${message}`,
      };
    }
  };
}
