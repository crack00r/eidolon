/**
 * Graceful shutdown orchestration for the daemon.
 *
 * performShutdown() orchestrates the ordered shutdown sequence.
 * teardownModules() is in teardown.ts and re-exported here for backward compatibility.
 */

import type { Logger } from "../logging/logger.ts";
import { teardownModules } from "./teardown.ts";
import type { InitializedModules } from "./types.ts";

// Re-export for backward compatibility
export { teardownModules } from "./teardown.ts";

// ---------------------------------------------------------------------------
// Public: perform graceful shutdown
// ---------------------------------------------------------------------------

export async function performShutdown(
  modules: InitializedModules,
  gracefulMs: number,
  logger: Logger | undefined,
): Promise<void> {
  logger?.info("daemon", `Graceful shutdown initiated (timeout: ${gracefulMs}ms)`);

  // 0-wf. Cancel all active workflow runs
  if (modules.workflowEngine) {
    try {
      modules.workflowEngine.cancelAllActive();
      logger?.info("daemon", "Step 0-wf: Active workflow runs cancelled");
    } catch (err: unknown) {
      logger?.error("daemon", "Step 0-wf: Error cancelling workflow runs", err);
    }
  }

  // 0a. Stop the CognitiveLoop if running (must happen before EventBus dispose)
  if (modules.cognitiveLoop?.running) {
    try {
      modules.cognitiveLoop.stop();
      logger?.info("daemon", "Step 0a: CognitiveLoop stopped");
    } catch (err: unknown) {
      logger?.error("daemon", "Step 0a: Error stopping CognitiveLoop", err);
    }
  }

  // 0b. Stop the scheduler polling interval
  if (modules.schedulerInterval) {
    try {
      clearInterval(modules.schedulerInterval);
      modules.schedulerInterval = undefined;
      logger?.info("daemon", "Step 0b: Scheduler polling interval cleared");
    } catch (err: unknown) {
      logger?.error("daemon", "Step 0b: Error clearing scheduler interval", err);
    }
  }

  // 1. Stop accepting new events -- dispose EventBus subscribers so no new
  //    handlers fire, while persisted events remain in SQLite for replay
  //    on next startup.
  if (modules.eventBus) {
    try {
      modules.eventBus.dispose();
      logger?.info("daemon", "Step 1: EventBus subscribers disposed (no new events will be processed)");
    } catch (err: unknown) {
      logger?.error("daemon", "Step 1: Error disposing EventBus subscribers", err);
    }
  } else {
    logger?.info("daemon", "Step 1: EventBus not initialized, skipping");
  }

  // 2. Signal sessions to complete -- abort all active Claude Code sessions.
  if (modules.sessionSupervisor) {
    const activeSessions = modules.sessionSupervisor.getActive();
    if (activeSessions.length > 0) {
      logger?.info("daemon", `Step 2: Aborting ${activeSessions.length} active session(s)`);
      for (const slot of activeSessions) {
        try {
          if (modules.claudeManager) {
            await modules.claudeManager.abort(slot.sessionId);
          }
          modules.sessionSupervisor.unregister(slot.sessionId);
          logger?.debug("daemon", `Session aborted: ${slot.sessionId} (${slot.type})`);
        } catch (err: unknown) {
          logger?.error("daemon", `Error aborting session ${slot.sessionId}`, err);
        }
      }
    } else {
      logger?.info("daemon", "Step 2: No active sessions to abort");
    }
  } else {
    logger?.info("daemon", "Step 2: SessionSupervisor not initialized, skipping");
  }

  // 3. Disconnect all registered channels via MessageRouter.
  if (modules.messageRouter) {
    const channels = modules.messageRouter.getChannels();
    if (channels.length > 0) {
      logger?.info("daemon", `Step 3: Disconnecting ${channels.length} channel(s)`);
      for (const channel of channels) {
        try {
          if (channel.isConnected()) {
            await channel.disconnect();
            logger?.debug("daemon", `Channel disconnected: ${channel.id}`);
          }
        } catch (err: unknown) {
          logger?.error("daemon", `Error disconnecting channel ${channel.id}`, err);
        }
      }
    } else {
      logger?.info("daemon", "Step 3: No channels registered");
    }
  } else {
    logger?.info("daemon", "Step 3: MessageRouter not initialized, skipping");
  }

  // 4. Flush pending metrics -- capture a final snapshot of gauge values
  if (modules.metricsRegistry) {
    try {
      if (modules.eventBus) {
        const pendingResult = modules.eventBus.pendingCount();
        if (pendingResult.ok) {
          modules.metricsRegistry.setEventQueueDepth(pendingResult.value);
        }
      }
      if (modules.sessionSupervisor) {
        modules.metricsRegistry.setActiveSessions(modules.sessionSupervisor.getActive().length);
      }
      logger?.info("daemon", "Step 4: Final metrics snapshot captured");
    } catch (err: unknown) {
      logger?.error("daemon", "Step 4: Error capturing final metrics", err);
    }
  } else {
    logger?.info("daemon", "Step 4: MetricsRegistry not available, skipping");
  }

  // 5. Publish shutdown event for any remaining listeners (best-effort).
  if (modules.eventBus) {
    try {
      modules.eventBus.publish(
        "system:shutdown",
        { reason: "graceful" },
        {
          priority: "critical",
          source: "daemon",
        },
      );
      logger?.debug("daemon", "Step 5: system:shutdown event persisted");
    } catch {
      // Best-effort: if EventBus DB is already closing, this is fine
    }
  }

  // 6. Teardown initialized modules in reverse, with timeout enforcement
  await Promise.race([
    teardownModules(modules, logger),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        reject(new Error(`Graceful shutdown timed out after ${gracefulMs}ms`));
      }, gracefulMs),
    ),
  ]).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger?.error("daemon", `Shutdown timeout: ${message} -- forcing exit`);
    process.exit(1);
  });
}
