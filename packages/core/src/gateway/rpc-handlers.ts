/**
 * Core RPC method handler factories for the Gateway server.
 *
 * Each function returns a MethodHandler that can be registered on a GatewayServer.
 * Handlers validate params with Zod, delegate to the appropriate module,
 * and return structured results.
 *
 * Split into sub-modules:
 *   - rpc-handlers-chat.ts   -- chat + memory handlers
 *   - rpc-handlers-session.ts -- session + learning + system handlers
 *   - rpc-handlers-voice.ts  -- voice handlers
 */

import type { Database } from "bun:sqlite";
import type { GPUWorkerPool } from "../gpu/pool.ts";
import type { HealthChecker } from "../health/checker.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { MemorySearch } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";
import {
  createChatSendHandler,
  createChatStreamHandler,
  createMemoryDeleteHandler,
  createMemorySearchHandler,
} from "./rpc-handlers-chat.ts";
import {
  createLearningApproveHandler,
  createLearningListHandler,
  createLearningRejectHandler,
  createSessionInfoHandler,
  createSessionListHandler,
  createSystemHealthHandler,
  createSystemStatusHandler,
} from "./rpc-handlers-session.ts";
import { createVoiceStartHandler, createVoiceStopHandler } from "./rpc-handlers-voice.ts";
import type { MethodHandler } from "./server.ts";

// ---------------------------------------------------------------------------
// Re-exports for backward compatibility
// ---------------------------------------------------------------------------

export {
  createChatSendHandler,
  createChatStreamHandler,
  createMemoryDeleteHandler,
  createMemorySearchHandler,
} from "./rpc-handlers-chat.ts";
export {
  createLearningApproveHandler,
  createLearningListHandler,
  createLearningRejectHandler,
  createSessionInfoHandler,
  createSessionListHandler,
  createSystemHealthHandler,
  createSystemStatusHandler,
} from "./rpc-handlers-session.ts";
export {
  clearActiveVoiceSessions,
  createVoiceStartHandler,
  createVoiceStopHandler,
  getActiveVoiceSessionCount,
} from "./rpc-handlers-voice.ts";

// ---------------------------------------------------------------------------
// Dependencies interface
// ---------------------------------------------------------------------------

/** Dependencies required by core RPC handlers. */
export interface CoreRpcDeps {
  readonly logger: Logger;
  readonly eventBus: EventBus;
  readonly operationalDb?: Database;
  readonly memorySearch?: MemorySearch;
  readonly memoryStore?: MemoryStore;
  readonly healthChecker?: HealthChecker;
  readonly gpuPool?: GPUWorkerPool;
  readonly startTime: number;
}

// ---------------------------------------------------------------------------
// Bulk registration helper
// ---------------------------------------------------------------------------

/** All core RPC handlers keyed by method name. */
export function createCoreRpcHandlers(deps: CoreRpcDeps): ReadonlyMap<string, MethodHandler> {
  const handlers = new Map<string, MethodHandler>();

  handlers.set("chat.send", createChatSendHandler(deps));
  handlers.set("chat.stream", createChatStreamHandler(deps));
  handlers.set("memory.search", createMemorySearchHandler(deps));
  handlers.set("memory.delete", createMemoryDeleteHandler(deps));
  handlers.set("session.list", createSessionListHandler(deps));
  handlers.set("session.info", createSessionInfoHandler(deps));
  handlers.set("learning.list", createLearningListHandler(deps));
  handlers.set("learning.approve", createLearningApproveHandler(deps));
  handlers.set("learning.reject", createLearningRejectHandler(deps));
  handlers.set("system.status", createSystemStatusHandler(deps));
  handlers.set("system.health", createSystemHealthHandler(deps));
  handlers.set("voice.start", createVoiceStartHandler(deps));
  handlers.set("voice.stop", createVoiceStopHandler(deps));

  return handlers;
}
