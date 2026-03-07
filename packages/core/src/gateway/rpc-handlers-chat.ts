/**
 * Chat and memory RPC handler factories for the Gateway server.
 */

import { randomUUID } from "node:crypto";
import type { MemoryLayer, MemoryType } from "@eidolon/protocol";
import { z } from "zod";
import type { CoreRpcDeps } from "./rpc-handlers.ts";
import type { MethodHandler } from "./server.ts";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ChatSendParamsSchema = z.object({
  text: z.string().min(1).max(100_000),
  channelId: z.string().min(1).max(64).optional(),
});

const ChatStreamParamsSchema = z.object({
  text: z.string().min(1).max(100_000),
  channelId: z.string().min(1).max(64).optional(),
});

const MemorySearchParamsSchema = z.object({
  query: z.string().min(1).max(4096),
  limit: z.number().int().min(1).max(100).optional(),
  types: z.array(z.string()).max(10).optional(),
  layers: z.array(z.string()).max(10).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  includeGraph: z.boolean().optional(),
});

const MemoryDeleteParamsSchema = z.object({
  id: z.string().min(1).max(256),
});

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

class RpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcValidationError";
  }
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

/** Create the chat.send handler. */
export function createChatSendHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params, clientId) => {
    const parsed = ChatSendParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(`Invalid chat.send params: ${parsed.error.issues.map((i) => i.message).join(", ")}`);
    }

    const { text, channelId } = parsed.data;
    const messageId = randomUUID();

    deps.eventBus.publish(
      "user:message",
      {
        messageId,
        channelId: channelId ?? "gateway",
        userId: clientId,
        text,
      },
      { source: "gateway", priority: "critical" },
    );

    deps.logger.info("chat.send", `Client ${clientId} sent message (${text.length} chars)`);

    return { messageId, status: "queued" };
  };
}

/** Create the chat.stream handler. */
export function createChatStreamHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params, clientId) => {
    const parsed = ChatStreamParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid chat.stream params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { text, channelId } = parsed.data;
    const messageId = randomUUID();
    const streamId = randomUUID();

    deps.eventBus.publish(
      "user:message",
      {
        messageId,
        streamId,
        channelId: channelId ?? "gateway",
        userId: clientId,
        text,
        streaming: true,
      },
      { source: "gateway", priority: "critical" },
    );

    deps.logger.info("chat.stream", `Client ${clientId} started streaming chat (${text.length} chars)`);

    return { messageId, streamId, status: "streaming" };
  };
}

/** Create the memory.search handler. */
export function createMemorySearchHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params) => {
    if (!deps.memorySearch) {
      throw new RpcValidationError("Memory search is not available");
    }

    const parsed = MemorySearchParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid memory.search params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { query, limit, types, layers, minConfidence, includeGraph } = parsed.data;

    const result = await deps.memorySearch.search({
      text: query,
      limit,
      types: types as MemoryType[] | undefined,
      layers: layers as MemoryLayer[] | undefined,
      minConfidence,
      includeGraph,
    });

    if (!result.ok) {
      throw new Error(result.error.message);
    }

    return {
      results: result.value.map((r) => ({
        id: r.memory.id,
        type: r.memory.type,
        layer: r.memory.layer,
        content: r.memory.content,
        confidence: r.memory.confidence,
        score: r.score,
        bm25Score: r.bm25Score,
        vectorScore: r.vectorScore,
        graphScore: r.graphScore,
        matchReason: r.matchReason,
        tags: r.memory.tags,
        createdAt: r.memory.createdAt,
        updatedAt: r.memory.updatedAt,
      })),
      total: result.value.length,
    };
  };
}

/** Create the memory.delete handler. */
export function createMemoryDeleteHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params) => {
    if (!deps.memoryStore) {
      throw new RpcValidationError("Memory store is not available");
    }

    const parsed = MemoryDeleteParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid memory.delete params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const result = deps.memoryStore.delete(parsed.data.id);
    if (!result.ok) {
      throw new RpcValidationError(result.error.message);
    }

    deps.logger.info("memory.delete", `Deleted memory ${parsed.data.id}`);

    return { deleted: true, id: parsed.data.id };
  };
}
