/**
 * Module teardown in reverse initialization order.
 * Extracted from shutdown.ts to keep files under 300 lines.
 */

import type { Logger } from "../logging/logger.ts";
import { flushWalCheckpoints } from "./lifecycle.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Public: teardown modules in reverse initialization order
// ---------------------------------------------------------------------------

export async function teardownModules(modules: InitializedModules, logger: Logger | undefined): Promise<void> {
  // Teardown in reverse initialization order.
  // Each step is wrapped in try/catch so a failure in one does not
  // prevent the remaining modules from being cleaned up.

  // 23 -> WorkflowEngine (clear all retry timers + abort controllers)
  if (modules.workflowEngine) {
    try {
      modules.workflowEngine.dispose();
      logger?.info("daemon", "WorkflowEngine disposed");
    } catch (err: unknown) {
      logger?.error("daemon", "Error disposing WorkflowEngine", err);
    }
  }

  // 22 -> ReplicationManager (stop heartbeat + snapshot timers)
  if (modules.replicationManager) {
    try {
      modules.replicationManager.stop();
      logger?.info("daemon", "ReplicationManager stopped");
    } catch (err: unknown) {
      logger?.error("daemon", "Error stopping ReplicationManager", err);
    }
  }

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
