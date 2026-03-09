/**
 * Realtime voice WebSocket reconnection and ping/pong logic.
 *
 * Extracted from realtime-client.ts to keep file sizes manageable.
 */

import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Reconnection configuration. */
export interface ReconnectConfig {
  readonly maxReconnectAttempts: number;
  readonly reconnectBaseDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  readonly pingIntervalMs: number;
}

/** State needed by reconnection logic. */
export interface ReconnectState {
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  pingTimer: ReturnType<typeof setInterval> | null;
  intentionalClose: boolean;
}

// ---------------------------------------------------------------------------
// Ping/pong keep-alive
// ---------------------------------------------------------------------------

/** Start periodic ping messages to keep the WebSocket alive. */
export function startPing(getWs: () => WebSocket | null, state: ReconnectState, config: ReconnectConfig): void {
  stopPing(state);
  const timer = setInterval(() => {
    const ws = getWs();
    if (ws !== null && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "ping" }));
      } catch {
        // Connection may be closing
      }
    }
  }, config.pingIntervalMs);
  timer.unref();
  state.pingTimer = timer;
}

/** Stop the ping timer. */
export function stopPing(state: ReconnectState): void {
  if (state.pingTimer !== null) {
    clearInterval(state.pingTimer);
    state.pingTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Reconnection with exponential backoff
// ---------------------------------------------------------------------------

/**
 * Schedule a reconnection attempt with exponential backoff.
 *
 * @param openConnectionFn - function that opens a new WebSocket connection
 * @param notifyErrorFn - function to notify error callbacks
 */
export function scheduleReconnect(
  state: ReconnectState,
  config: ReconnectConfig,
  logger: Logger,
  openConnectionFn: () => Promise<{ ok: boolean; error?: { message: string } }>,
  notifyErrorFn: (error: Error) => void,
): void {
  if (state.reconnectAttempts >= config.maxReconnectAttempts) {
    logger.warn("reconnect", "Max reconnection attempts reached", {
      attempts: state.reconnectAttempts,
      max: config.maxReconnectAttempts,
    });
    notifyErrorFn(new Error(`Max reconnection attempts (${config.maxReconnectAttempts}) reached`));
    return;
  }

  const delay = Math.min(config.reconnectBaseDelayMs * 2 ** state.reconnectAttempts, config.reconnectMaxDelayMs);

  state.reconnectAttempts += 1;

  logger.info("reconnect", `Scheduling reconnect attempt ${state.reconnectAttempts}`, {
    delayMs: delay,
  });

  // ERR-002: Properly handle reconnect promise to prevent unhandled rejections
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    openConnectionFn()
      .then((result) => {
        if (!result.ok) {
          logger.warn("reconnect", `Reconnect attempt ${state.reconnectAttempts} failed`, {
            error: result.error?.message,
          });
        }
      })
      .catch((err: unknown) => {
        logger.error("reconnect", "Reconnect attempt threw unexpected error", err);
        notifyErrorFn(err instanceof Error ? err : new Error(String(err)));
      });
  }, delay);
}

/** Clear any pending reconnection timer. */
export function clearReconnectTimer(state: ReconnectState): void {
  if (state.reconnectTimer !== null) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
}
