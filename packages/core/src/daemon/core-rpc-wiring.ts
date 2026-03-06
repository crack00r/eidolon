/**
 * Core RPC handler wiring for the Gateway server.
 *
 * Registers chat, memory, session, learning, system, and voice RPC handlers
 * on the GatewayServer using available modules from InitializedModules.
 */

import type { GatewayMethod } from "@eidolon/protocol";
import type { CoreRpcDeps } from "../gateway/rpc-handlers.ts";
import { createCoreRpcHandlers } from "../gateway/rpc-handlers.ts";
import type { InitializedModules } from "./types.ts";

/**
 * Build the init step that wires core RPC handlers to the gateway.
 * Should run after GatewayServer is initialized (step 19) and after
 * memory/health modules are available.
 */
export function buildCoreRpcWiringStep(modules: InitializedModules): { name: string; fn: () => void } {
  return {
    name: "GatewayCoreRpcWiring",
    fn: () => {
      const gateway = modules.gatewayServer;
      const logger = modules.logger;

      if (!gateway || !logger || !modules.eventBus) {
        logger?.debug("daemon", "Core RPC wiring skipped: missing gateway, logger, or eventBus");
        return;
      }

      const deps: CoreRpcDeps = {
        logger,
        eventBus: modules.eventBus,
        operationalDb: modules.dbManager?.operational,
        memorySearch: modules.memorySearch,
        memoryStore: modules.memoryStore,
        healthChecker: modules.healthChecker,
        startTime: Date.now(),
      };

      const handlers = createCoreRpcHandlers(deps);
      let registered = 0;

      for (const [method, handler] of handlers) {
        gateway.registerHandler(method as GatewayMethod, handler);
        registered++;
      }

      logger.info("daemon", `Core RPC handlers registered on gateway (${registered} methods)`);
    },
  };
}
