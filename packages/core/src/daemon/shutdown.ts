/**
 * Graceful shutdown and module teardown for the daemon.
 *
 * performShutdown() orchestrates the ordered shutdown sequence.
 * teardownModules() tears down initialized modules in reverse order.
 */

import type { Logger } from "../logging/logger.ts";
import { flushWalCheckpoints } from "./lifecycle.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Public: perform graceful shutdown
// ---------------------------------------------------------------------------

export async function performShutdown(
  modules: InitializedModules,
  gracefulMs: number,
  logger: Logger | undefined,
): Promise<void> {
  logger?.info("daemon", `Graceful shutdown initiated (timeout: ${gracefulMs}ms)`);

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
  //    SessionSupervisor tracks session slots (metadata), while
  //    ClaudeCodeManager owns the actual subprocesses.
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
  //    The Telegram channel has its own explicit teardown in teardownModules(),
  //    but this covers any other channels that may be registered dynamically.
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
  //    before metrics wiring is disposed in teardownModules().
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
  //    EventBus subscribers were disposed in step 1, but the event is
  //    persisted to SQLite so it can be replayed on restart if needed.
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

// ---------------------------------------------------------------------------
// Public: teardown modules in reverse initialization order
// ---------------------------------------------------------------------------

export async function teardownModules(modules: InitializedModules, logger: Logger | undefined): Promise<void> {
  // Teardown in reverse initialization order.
  // Each step is wrapped in try/catch so a failure in one does not
  // prevent the remaining modules from being cleaned up.

  // 21 -> Discovery broadcaster (stop UDP + mDNS)
  if (modules.discoveryBroadcaster) {
    try {
      await modules.discoveryBroadcaster.stop();
      logger?.info("daemon", "DiscoveryBroadcaster stopped");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping DiscoveryBroadcaster", err);
    }
  }

  // 20 -> Tailscale detector
  if (modules.tailscaleDetector) {
    try {
      modules.tailscaleDetector.stop();
      logger?.info("daemon", "TailscaleDetector stopped");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping TailscaleDetector", err);
    }
  }

  // 19a-cal -> CalendarManager (stop sync intervals, disconnect providers)
  if (modules.calendarManager) {
    try {
      await modules.calendarManager.dispose();
      logger?.info("daemon", "CalendarManager disposed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disposing CalendarManager", err);
    }
  }

  // 19a-ha -> HAManager (stop sync interval)
  if (modules.haManager) {
    try {
      await modules.haManager.dispose();
      logger?.info("daemon", "HAManager disposed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disposing HAManager", err);
    }
  }

  // 14b -> Plugin system (stop and destroy all plugins)
  if (modules.pluginLifecycle) {
    try {
      await modules.pluginLifecycle.stopAll();
      await modules.pluginLifecycle.destroyAll();
      logger?.info("daemon", "Plugin lifecycle stopped and destroyed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping plugin lifecycle", err);
    }
  }

  // 19c -> Metrics wiring (dispose before gateway so interval timers stop)
  if (modules.metricsWiring) {
    try {
      modules.metricsWiring.dispose();
      logger?.info("daemon", "MetricsWiring disposed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disposing MetricsWiring", err);
    }
  }

  // 19 -> Gateway server
  if (modules.gatewayServer) {
    try {
      await modules.gatewayServer.stop();
      logger?.info("daemon", "GatewayServer stopped");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping GatewayServer", err);
    }
  }

  // 17 -> Telegram channel (disconnect bot polling)
  if (modules.telegramChannel) {
    try {
      await modules.telegramChannel.disconnect();
      modules.messageRouter?.unregisterChannel("telegram");
      logger?.info("daemon", "Telegram channel disconnected");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disconnecting Telegram channel", err);
    }
  }

  // 17 -> Discord channel (disconnect bot)
  if (modules.discordChannel) {
    try {
      await modules.discordChannel.disconnect();
      modules.messageRouter?.unregisterChannel("discord");
      logger?.info("daemon", "Discord channel disconnected");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disconnecting Discord channel", err);
    }
  }

  // 17 -> WhatsApp channel (disconnect)
  if (modules.whatsappChannel) {
    try {
      await modules.whatsappChannel.disconnect();
      modules.messageRouter?.unregisterChannel("whatsapp");
      logger?.info("daemon", "WhatsApp channel disconnected");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disconnecting WhatsApp channel", err);
    }
  }

  // 17 -> Email channel (disconnect)
  if (modules.emailChannel) {
    try {
      await modules.emailChannel.disconnect();
      modules.messageRouter?.unregisterChannel("email");
      logger?.info("daemon", "Email channel disconnected");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disconnecting Email channel", err);
    }
  }

  // 7c -> MetricsBridge (dispose before telemetry shutdown)
  if (modules.metricsBridge) {
    try {
      modules.metricsBridge.dispose();
      logger?.info("daemon", "MetricsBridge disposed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disposing MetricsBridge", err);
    }
  }

  // 7c -> TelemetryProvider (flush pending spans/metrics)
  if (modules.telemetryProvider) {
    try {
      await modules.telemetryProvider.shutdown();
      logger?.info("daemon", "TelemetryProvider shut down");
    } catch (err: unknown) {
      logger?.error("daemon", "Error shutting down TelemetryProvider", err);
    }
  }

  // 16 -> CognitiveLoop: stop if running (safety net for startup-failure teardown)
  if (modules.cognitiveLoop?.running) {
    try {
      modules.cognitiveLoop.stop();
      logger?.info("daemon", "CognitiveLoop stopped (teardown)");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping CognitiveLoop", err);
    }
  }

  // 16 -> Scheduler polling interval (safety net)
  if (modules.schedulerInterval) {
    try {
      clearInterval(modules.schedulerInterval);
      modules.schedulerInterval = undefined;
      logger?.info("daemon", "Scheduler interval cleared (teardown)");
    } catch (err: unknown) {
      logger?.error("daemon", "Error clearing scheduler interval", err);
    }
  }

  // 12b -> DocumentIndexer: stop re-indexing interval
  if (modules.documentIndexerInterval) {
    try {
      clearInterval(modules.documentIndexerInterval);
      modules.documentIndexerInterval = undefined;
      logger?.info("daemon", "DocumentIndexer interval cleared");
    } catch (err: unknown) {
      logger?.error("daemon", "Error clearing DocumentIndexer interval", err);
    }
  }

  // 12c -> DocumentWatcher: stop file watching
  if (modules.documentWatcher?.isWatching) {
    try {
      modules.documentWatcher.stopWatching();
      logger?.info("daemon", "DocumentWatcher stopped");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping DocumentWatcher", err);
    }
  }

  // 15 -> SessionSupervisor: unregister any remaining sessions.
  //    Claude subprocesses were aborted in performShutdown step 2,
  //    but during startup-failure teardown performShutdown is not called.
  if (modules.sessionSupervisor?.hasActiveSessions()) {
    const remaining = modules.sessionSupervisor.getActive();
    for (const slot of remaining) {
      try {
        if (modules.claudeManager) {
          await modules.claudeManager.abort(slot.sessionId);
        }
        modules.sessionSupervisor.unregister(slot.sessionId);
      } catch (err: unknown) {
        logger?.error("daemon", `Error cleaning up session ${slot.sessionId}`, err);
      }
    }
    logger?.info("daemon", `SessionSupervisor: cleaned up ${remaining.length} remaining session(s)`);
  }

  // 10b -> Feedback confidence subscription: unsubscribe before EventBus dispose
  if (modules.feedbackConfidenceUnsub) {
    try {
      modules.feedbackConfidenceUnsub();
      modules.feedbackConfidenceUnsub = undefined;
      logger?.info("daemon", "Feedback confidence subscription unsubscribed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error unsubscribing feedback confidence", err);
    }
  }

  // 10c -> ApprovalManager: stop periodic timeout checking
  if (modules.approvalManager) {
    try {
      modules.approvalManager.stop();
      logger?.info("daemon", "ApprovalManager stopped");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping ApprovalManager", err);
    }
  }

  // 10 -> EventBus: dispose subscribers as safety net.
  //    During normal shutdown, performShutdown already called dispose().
  //    During startup-failure teardown, this ensures cleanup.
  if (modules.eventBus) {
    try {
      modules.eventBus.dispose();
      logger?.info("daemon", "EventBus disposed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disposing EventBus", err);
    }
  }

  // 9 -> Health server
  if (modules.healthServer) {
    try {
      await modules.healthServer.stop();
      logger?.info("daemon", "Health server stopped");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping health server", err);
    }
  }

  // 18b -> GPUWorkerPool: stop health checks
  if (modules.gpuWorkerPool) {
    try {
      modules.gpuWorkerPool.dispose();
      logger?.info("daemon", "GPUWorkerPool disposed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disposing GPUWorkerPool", err);
    }
  }

  // 6b -> MCPHealthMonitor
  if (modules.mcpHealthMonitor) {
    try {
      modules.mcpHealthMonitor.dispose();
      logger?.info("daemon", "MCPHealthMonitor disposed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disposing MCPHealthMonitor", err);
    }
  }

  // 4b -> ConfigWatcher: stop watching config file
  if (modules.configWatcher) {
    try {
      modules.configWatcher.stop();
      modules.configWatcher = undefined;
      logger?.info("daemon", "ConfigWatcher stopped");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping ConfigWatcher", err);
    }
  }

  // 3 -> SecretStore
  if (modules.secretStore) {
    try {
      modules.secretStore.close();
      logger?.info("daemon", "SecretStore closed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error closing SecretStore", err);
    }
  }

  // 5 -> Databases (WAL checkpoint then close) -- last data-layer teardown
  if (modules.dbManager) {
    try {
      flushWalCheckpoints(modules.dbManager, logger);
      modules.dbManager.close();
      logger?.info("daemon", "Databases closed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error closing databases", err);
    }
  }
}
