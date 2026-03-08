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

/** Keys whose values are stripped from config before exposing to plugins. */
const SENSITIVE_KEY_PATTERNS = ["key", "secret", "token", "password", "credential", "masterkey"];

/**
 * Deep-filter a config object, removing fields whose names contain
 * sensitive keywords and stripping known sensitive paths.
 */
function filterSensitiveConfig(obj: unknown): unknown {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(filterSensitiveConfig);

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEY_PATTERNS.some((pattern) => lower.includes(pattern))) {
      continue; // Strip sensitive fields
    }
    result[key] = filterSensitiveConfig(value);
  }
  return result;
}

const VALID_PRIORITIES = new Set(["critical", "high", "normal", "low"]);

/** Validate and return a typed priority string, defaulting to "normal". */
function validatePriority(priority: string | undefined): "critical" | "high" | "normal" | "low" {
  if (priority !== undefined && VALID_PRIORITIES.has(priority)) {
    return priority as "critical" | "high" | "normal" | "low";
  }
  return "normal";
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

    onEvent(type: string, handler: (event: unknown) => void) {
      requirePermission(permissions, "events:listen", "listen to events");
      if (!deps.eventBus) throw new Error("EventBus not available");
      // Plugin-provided event type string is cast to EventType for the internal API.
      // The EventBus will ignore unknown event types at subscription time.
      const eventType: EventType = type as EventType;
      return deps.eventBus.subscribe(eventType, handler);
    },

    emitEvent(type: string, payload: unknown, priority?: string) {
      requirePermission(permissions, "events:emit", "emit events");
      if (!deps.eventBus) throw new Error("EventBus not available");
      const eventType: EventType = type as EventType;
      const validPriority = validatePriority(priority);
      deps.eventBus.publish(eventType, payload, {
        source: `plugin:${pluginName}`,
        priority: validPriority,
      });
    },

    getConfig(): Record<string, unknown> {
      requirePermission(permissions, "config:read", "read config");
      return filterSensitiveConfig(deps.config) as Record<string, unknown>;
    },

    registerRpcHandler(method: string, handler: (params: unknown) => Promise<unknown>) {
      requirePermission(permissions, "gateway:register", "register RPC handler");
      if (!deps.gateway) throw new Error("Gateway not available");
      // Prefix plugin methods to avoid collisions. The gateway handler type
      // uses a branded string for method names, so a type assertion is needed
      // for the runtime-constructed method name.
      const fullMethod = `plugin:${pluginName}.${method}`;
      type HandlerMethod = Parameters<typeof deps.gateway.registerHandler>[0];
      deps.gateway.registerHandler(fullMethod as HandlerMethod, async (params: unknown) => handler(params));
    },

    registerChannel(channel: unknown) {
      requirePermission(permissions, "channel:register", "register channel");
      if (!deps.messageRouter) throw new Error("MessageRouter not available");
      // Channel is plugin-provided; registerChannel validates it internally.
      type ChannelParam = Parameters<typeof deps.messageRouter.registerChannel>[0];
      deps.messageRouter.registerChannel(channel as ChannelParam);
    },
  };
}
