/**
 * Metrics wiring -- connects MetricsRegistry to EventBus and SessionSupervisor.
 *
 * Subscribes to event bus events to increment counters (events processed,
 * tokens used, cost) and periodically updates gauges (active sessions,
 * event queue depth).
 */

import type { TokenUsage } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import type { SessionSupervisor } from "../loop/session-supervisor.ts";
import type { MetricsRegistry } from "./prometheus.ts";

/** Interval in milliseconds for updating gauge metrics. */
const GAUGE_UPDATE_INTERVAL_MS = 5_000;

/** Teardown handle returned by wireMetrics to allow clean shutdown. */
export interface MetricsWiringHandle {
  /** Unsubscribe from all event bus subscriptions and clear timers. */
  dispose(): void;
}

export interface MetricsWiringDeps {
  readonly metricsRegistry: MetricsRegistry;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly sessionSupervisor?: SessionSupervisor;
}

/**
 * Wire a MetricsRegistry to the daemon's event bus and session supervisor.
 *
 * - Subscribes to all events to increment `eventsProcessed` counter.
 * - Listens for `session:started` / `session:completed` / `session:failed`
 *   to update `activeSessions` gauge.
 * - Starts a periodic timer to refresh `eventQueueDepth` gauge.
 * - Provides a `dispose()` handle for clean teardown.
 */
export function wireMetrics(deps: MetricsWiringDeps): MetricsWiringHandle {
  const { metricsRegistry, eventBus, logger, sessionSupervisor } = deps;
  const unsubscribers: Array<() => void> = [];

  // 1. Count every event processed
  const unsubAll = eventBus.subscribeAll(() => {
    metricsRegistry.incEventsProcessed();
  });
  unsubscribers.push(unsubAll);

  // 2. Update active sessions gauge on session lifecycle events
  const updateSessionGauge = (): void => {
    if (sessionSupervisor) {
      metricsRegistry.setActiveSessions(sessionSupervisor.getActive().length);
    }
  };

  const unsubStarted = eventBus.subscribe("session:started", () => {
    updateSessionGauge();
  });
  unsubscribers.push(unsubStarted);

  const unsubCompleted = eventBus.subscribe("session:completed", () => {
    updateSessionGauge();
  });
  unsubscribers.push(unsubCompleted);

  const unsubFailed = eventBus.subscribe("session:failed", () => {
    updateSessionGauge();
  });
  unsubscribers.push(unsubFailed);

  // 3. Periodic gauge updates (event queue depth, session count)
  const gaugeTimer = setInterval(() => {
    const pendingResult = eventBus.pendingCount();
    if (pendingResult.ok) {
      metricsRegistry.setEventQueueDepth(pendingResult.value);
    }
    updateSessionGauge();
  }, GAUGE_UPDATE_INTERVAL_MS);
  gaugeTimer.unref();

  // Run initial gauge update immediately
  const initialPending = eventBus.pendingCount();
  if (initialPending.ok) {
    metricsRegistry.setEventQueueDepth(initialPending.value);
  }
  updateSessionGauge();

  logger.info("metrics-wiring", "Prometheus metrics wired to event bus and session supervisor");

  return {
    dispose(): void {
      clearInterval(gaugeTimer);
      for (const unsub of unsubscribers) {
        unsub();
      }
      logger.debug("metrics-wiring", "Metrics wiring disposed");
    },
  };
}

/**
 * Record token usage into the MetricsRegistry.
 *
 * Call this after TokenTracker.record() to keep Prometheus counters in sync.
 * Separated from wireMetrics because token recording is a direct function call,
 * not an event bus subscription.
 */
export function recordTokenMetrics(registry: MetricsRegistry, usage: TokenUsage): void {
  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  registry.incTokensUsed(usage.model, totalTokens);
  registry.incCostUsd(usage.costUsd);
}
