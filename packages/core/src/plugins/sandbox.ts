/**
 * Plugin sandbox -- creates a permission-gated PluginContext for each plugin.
 */

import type { EidolonConfig, EventType, PluginContext, PluginLogger, PluginPermission } from "@eidolon/protocol";
import type { MessageRouter } from "../channels/router.ts";
import type { GatewayServer } from "../gateway/server.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";

export interface SandboxDeps {
  readonly logger: Logger;
  readonly config: EidolonConfig;
  readonly eventBus?: EventBus;
  readonly gateway?: GatewayServer;
  readonly messageRouter?: MessageRouter;
}

function requirePermission(
  permissions: ReadonlySet<PluginPermission>,
  required: PluginPermission,
  action: string,
): void {
  if (!permissions.has(required)) {
    throw new Error(`Plugin lacks permission "${required}" to ${action}`);
  }
}

/**
 * Build a sandboxed PluginContext for the given plugin.
 */
export function createPluginContext(
  pluginName: string,
  grantedPermissions: readonly PluginPermission[],
  deps: SandboxDeps,
): PluginContext {
  const permissions = new Set<PluginPermission>(grantedPermissions);

  const log: PluginLogger = {
    debug: (msg, data) => deps.logger.debug(`plugin:${pluginName}`, msg, data),
    info: (msg, data) => deps.logger.info(`plugin:${pluginName}`, msg, data),
    warn: (msg, data) => deps.logger.warn(`plugin:${pluginName}`, msg, data),
    error: (msg, data) => deps.logger.error(`plugin:${pluginName}`, msg, data),
  };

  return {
    pluginName,
    permissions,
    log,

    onEvent(type, handler) {
      requirePermission(permissions, "events:listen", "listen to events");
      if (!deps.eventBus) throw new Error("EventBus not available");
      return deps.eventBus.subscribe(type as EventType, handler as (event: unknown) => void);
    },

    emitEvent(type, payload, priority) {
      requirePermission(permissions, "events:emit", "emit events");
      if (!deps.eventBus) throw new Error("EventBus not available");
      deps.eventBus.publish(type as EventType, payload, {
        source: `plugin:${pluginName}`,
        priority: priority as "normal" | "critical" | "high" | "low" | undefined,
      });
    },

    getConfig() {
      requirePermission(permissions, "config:read", "read config");
      return deps.config as unknown as Record<string, unknown>;
    },

    registerRpcHandler(method, handler) {
      requirePermission(permissions, "gateway:register", "register RPC handler");
      if (!deps.gateway) throw new Error("Gateway not available");
      // Prefix plugin methods to avoid collisions
      const fullMethod = `plugin:${pluginName}.${method}`;
      deps.gateway.registerHandler(fullMethod as never, async (params: unknown) => handler(params));
    },

    registerChannel(channel) {
      requirePermission(permissions, "channel:register", "register channel");
      if (!deps.messageRouter) throw new Error("MessageRouter not available");
      deps.messageRouter.registerChannel(channel as never);
    },
  };
}
