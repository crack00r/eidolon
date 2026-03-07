/**
 * Voice RPC handler factories for the Gateway server.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CoreRpcDeps } from "./rpc-handlers.ts";
import type { MethodHandler } from "./server.ts";

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const VoiceStartParamsSchema = z.object({
  codec: z.enum(["opus", "pcm"]).optional(),
  sampleRate: z.number().int().positive().optional(),
});

const VoiceStopParamsSchema = z.object({
  sessionId: z.string().min(1).max(256),
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
// Active voice session tracking
// ---------------------------------------------------------------------------

/** Active voice sessions tracked by client ID -> session info. */
const activeVoiceSessions = new Map<string, { sessionId: string; clientId: string; startedAt: number }>();

/**
 * Get the number of currently active voice sessions.
 * Exposed for testing purposes.
 */
export function getActiveVoiceSessionCount(): number {
  return activeVoiceSessions.size;
}

/**
 * Clear all active voice sessions.
 * Exposed for testing purposes only.
 */
export function clearActiveVoiceSessions(): void {
  activeVoiceSessions.clear();
}

// ---------------------------------------------------------------------------
// Handler factories
// ---------------------------------------------------------------------------

/** Create the voice.start handler. */
export function createVoiceStartHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params, clientId) => {
    const parsed = VoiceStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid voice.start params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    // Check if client already has an active voice session
    const existing = activeVoiceSessions.get(clientId);
    if (existing) {
      throw new RpcValidationError(
        `Client ${clientId} already has an active voice session: ${existing.sessionId}. Stop it first.`,
      );
    }

    // Check GPU pool availability
    const gpuPool = deps.gpuPool;
    let gpuAvailable = false;
    let ttsAvailable = false;
    let sttAvailable = false;
    let poolStatus: { totalWorkers: number; healthyWorkers: number } | undefined;

    if (gpuPool) {
      ttsAvailable = gpuPool.hasCapability("tts");
      sttAvailable = gpuPool.hasCapability("stt");
      gpuAvailable = ttsAvailable || sttAvailable;
      const status = gpuPool.getPoolStatus();
      poolStatus = { totalWorkers: status.totalWorkers, healthyWorkers: status.healthyWorkers };
    }

    if (!gpuAvailable) {
      deps.logger.warn("voice.start", `Client ${clientId} requested voice but no GPU workers are available`);
      throw new RpcValidationError(
        "No GPU workers available for voice. Ensure at least one GPU worker with TTS or STT capability is online.",
      );
    }

    const sessionId = randomUUID();
    const now = Date.now();

    // Track the active voice session
    activeVoiceSessions.set(clientId, { sessionId, clientId, startedAt: now });

    deps.logger.info("voice.start", `Client ${clientId} started voice session ${sessionId}`, {
      ttsAvailable,
      sttAvailable,
      healthyWorkers: poolStatus?.healthyWorkers,
    });

    // Publish event for the cognitive loop
    deps.eventBus.publish(
      "session:started",
      {
        sessionId,
        sessionType: "voice",
        clientId,
        codec: parsed.data.codec ?? "opus",
        sampleRate: parsed.data.sampleRate ?? 24_000,
      },
      { source: "gateway", priority: "normal" },
    );

    return {
      sessionId,
      status: "ready",
      config: {
        codec: parsed.data.codec ?? "opus",
        sampleRate: parsed.data.sampleRate ?? 24_000,
        channels: 1,
      },
      capabilities: {
        tts: ttsAvailable,
        stt: sttAvailable,
      },
      gpu: poolStatus,
    };
  };
}

/** Create the voice.stop handler. */
export function createVoiceStopHandler(deps: CoreRpcDeps): MethodHandler {
  return async (params, clientId) => {
    const parsed = VoiceStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new RpcValidationError(
        `Invalid voice.stop params: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { sessionId } = parsed.data;

    // Look up the active session for this client
    const session = activeVoiceSessions.get(clientId);
    if (!session) {
      throw new RpcValidationError(`No active voice session found for client ${clientId}`);
    }

    if (session.sessionId !== sessionId) {
      throw new RpcValidationError(`Session ID mismatch: expected ${session.sessionId}, got ${sessionId}`);
    }

    const durationMs = Date.now() - session.startedAt;

    // Remove the tracked session
    activeVoiceSessions.delete(clientId);

    deps.logger.info("voice.stop", `Client ${clientId} stopped voice session ${sessionId}`, {
      durationMs,
    });

    // Publish event for the cognitive loop
    deps.eventBus.publish(
      "session:completed",
      {
        sessionId,
        sessionType: "voice",
        clientId,
        durationMs,
      },
      { source: "gateway", priority: "normal" },
    );

    return { stopped: true, sessionId, durationMs };
  };
}
