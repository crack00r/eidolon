/**
 * WebSocket client for communicating with the Eidolon Core gateway.
 * Uses JSON-RPC 2.0 protocol over WebSocket on port 8419.
 *
 * Supports bidirectional communication:
 * - Client → Server: JSON-RPC 2.0 requests (call method)
 * - Server → Client: Push notifications (on method + typed event handlers)
 * - Client → Client: via client.execute / push.executeCommand relay
 */

import { clientLog, getRecentErrors, clearErrorBuffer } from "./logger";

export interface GatewayConfig {
  host: string;
  port: number;
  token?: string;
  useTls?: boolean;
  /** Client platform identifier sent during authentication. */
  platform?: string;
  /** Client version string sent during authentication. */
  version?: string;
}

export type ConnectionState = "disconnected" | "connecting" | "authenticating" | "connected" | "error";

/** Known push notification types from the server. */
export type PushEventType =
  | "push.stateChange"
  | "push.taskStarted"
  | "push.taskCompleted"
  | "push.memoryCreated"
  | "push.learningDiscovery"
  | "push.energyUpdate"
  | "push.error"
  | "push.clientConnected"
  | "push.clientDisconnected"
  | "push.executeCommand"
  | "system.statusUpdate";

type PushEventHandler = (params: Record<string, unknown>) => void;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
  method?: string;
  params?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RECONNECT_DELAY_MS = 8_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 50;
/** Maximum accepted inbound WebSocket message size (1 MB). */
const MAX_MESSAGE_SIZE = 1_048_576;
/** Allowed characters for hostname to prevent URL injection. */
const HOSTNAME_RE = /^[a-zA-Z0-9._-]+$/;

export class GatewayClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private pushHandlers = new Set<(method: string, params: Record<string, unknown>) => void>();
  private typedPushHandlers = new Map<string, Set<PushEventHandler>>();
  private stateHandlers = new Set<(state: ConnectionState) => void>();
  private currentState: ConnectionState = "disconnected";
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = false;
  private config: GatewayConfig;

  constructor(config: GatewayConfig) {
    this.config = config;
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  updateConfig(config: GatewayConfig): void {
    this.config = config;
  }

  connect(): void {
    if (this.ws && this.currentState !== "disconnected" && this.currentState !== "error") {
      return;
    }

    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.establishConnection();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.reconnectAttempts = 0;

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, "Client disconnect");
      this.ws = null;
    }

    this.rejectAllPending("Client disconnected");
    this.setState("disconnected");
  }

  async call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.currentState !== "connected") {
      throw new Error(`Cannot send request: connection state is "${this.currentState}"`);
    }

    const id = this.nextId();
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout: ${method} (id=${id})`));
      }, DEFAULT_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        if (!this.ws) {
          throw new Error("WebSocket is not connected");
        }
        this.ws.send(JSON.stringify(request));
      } catch (sendErr) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(sendErr instanceof Error ? sendErr : new Error("WebSocket send failed"));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Brain control convenience methods
  // -------------------------------------------------------------------------

  /** Pause the cognitive loop. */
  async pauseBrain(): Promise<{ paused: boolean }> {
    return this.call<{ paused: boolean }>("brain.pause");
  }

  /** Resume the cognitive loop. */
  async resumeBrain(): Promise<{ resumed: boolean }> {
    return this.call<{ resumed: boolean }>("brain.resume");
  }

  /** Trigger a specific brain action. */
  async triggerAction(action: string, args?: Record<string, unknown>): Promise<{ triggered: boolean; action: string }> {
    return this.call<{ triggered: boolean; action: string }>("brain.triggerAction", {
      action,
      ...(args ? { args } : {}),
    });
  }

  /** Get recent log entries. */
  async getLog(limit?: number): Promise<{ entries: unknown[]; limit: number }> {
    return this.call<{ entries: unknown[]; limit: number }>("brain.getLog", limit !== undefined ? { limit } : {});
  }

  /** List all connected clients. */
  async listClients(): Promise<{
    clients: ReadonlyArray<{
      id: string;
      platform: string;
      version: string;
      connectedAt: number;
      subscribed: boolean;
    }>;
  }> {
    return this.call("client.list");
  }

  /** Send a command to a specific client via the server relay. */
  async executeOnClient(
    targetClientId: string,
    command: string,
    args?: unknown,
  ): Promise<{ sent: boolean; commandId: string; targetClientId: string }> {
    return this.call("client.execute", {
      targetClientId,
      command,
      ...(args !== undefined ? { args } : {}),
    });
  }

  /** Report the result of an executed command back to the server. */
  async reportCommandResult(
    commandId: string,
    success: boolean,
    result?: unknown,
    error?: string,
  ): Promise<{ received: boolean; commandId: string }> {
    return this.call("command.result", {
      commandId,
      success,
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  /** Subscribe to real-time status updates from the server. */
  async subscribe(): Promise<{ subscribed: boolean }> {
    return this.call<{ subscribed: boolean }>("system.subscribe");
  }

  // -------------------------------------------------------------------------
  // Push notification handlers
  // -------------------------------------------------------------------------

  /** Register a generic handler for all push notifications. */
  onPush(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.pushHandlers.add(handler);
    return () => {
      this.pushHandlers.delete(handler);
    };
  }

  /**
   * Register a typed handler for a specific push event type.
   * Example: `api.on('push.stateChange', (params) => { ... })`
   */
  on(eventType: PushEventType, handler: PushEventHandler): () => void {
    let handlers = this.typedPushHandlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.typedPushHandlers.set(eventType, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.typedPushHandlers.delete(eventType);
      }
    };
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  private nextId(): string {
    return String(++this.requestId);
  }

  private establishConnection(): void {
    this.setState("connecting");

    if (!HOSTNAME_RE.test(this.config.host)) {
      clientLog("error", "gateway", "Invalid hostname", { host: this.config.host });
      this.setState("error");
      return;
    }

    const scheme = this.config.useTls === true ? "wss" : "ws";
    const url = `${scheme}://${this.config.host}:${this.config.port}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.setState("error");
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;

      // CLIENT-003: Warn when sending a token over unencrypted ws:// connection
      if (this.config.token && scheme === "ws") {
        clientLog(
          "warn",
          "gateway",
          "SECURITY WARNING: Auth token is being sent over an unencrypted ws:// connection. " +
            "The token will be transmitted in plaintext. Use wss:// (TLS) in production.",
        );
      }

      if (this.config.token) {
        this.setState("authenticating");
        this.sendAuth();
      } else {
        // CLIENT-002: Warn when connecting without authentication
        clientLog(
          "warn",
          "gateway",
          "SECURITY WARNING: Connecting to gateway without an authentication token. " +
            "The connection is unauthenticated and should not be used in production.",
        );
        this.setState("connected");
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      // Ignore binary frames — we only handle JSON text messages
      if (typeof event.data !== "string") return;
      this.handleMessage(event.data);
    };

    this.ws.onclose = () => {
      this.ws = null;
      this.rejectAllPending("Connection closed");

      if (this.shouldReconnect) {
        this.setState("disconnected");
        this.scheduleReconnect();
      } else {
        this.setState("disconnected");
      }
    };

    this.ws.onerror = () => {
      // onclose will fire after onerror, handle reconnect there
      this.setState("error");
    };
  }

  private sendAuth(): void {
    if (!this.ws || !this.config.token) return;

    const id = this.nextId();
    const authRequest: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method: "auth.authenticate",
      params: {
        token: this.config.token,
        platform: this.config.platform ?? "desktop",
        version: this.config.version ?? "0.0.0",
      },
    };

    const timer = setTimeout(() => {
      this.pendingRequests.delete(id);
      this.setState("error");
      this.ws?.close(4001, "Auth timeout");
    }, DEFAULT_TIMEOUT_MS);

    this.pendingRequests.set(id, {
      resolve: () => {
        this.setState("connected");
      },
      reject: (err: Error) => {
        this.setState("error");
        clientLog("error", "gateway", "Authentication failed", { error: err.message });
        this.ws?.close(4002, "Auth failed");
      },
      timer,
    });

    this.ws.send(JSON.stringify(authRequest));
  }

  private handleMessage(data: string): void {
    // Guard against oversized messages to prevent memory exhaustion
    if (data.length > MAX_MESSAGE_SIZE) {
      clientLog("warn", "gateway", "Gateway message too large, dropping", { bytes: data.length });
      return;
    }

    let message: JsonRpcResponse;
    try {
      message = JSON.parse(data) as JsonRpcResponse;
    } catch {
      clientLog("error", "gateway", "Failed to parse gateway message");
      return;
    }

    // Validate JSON-RPC 2.0 envelope
    if (
      message.jsonrpc !== "2.0" ||
      (message.result === undefined && message.error === undefined && message.method === undefined)
    ) {
      clientLog("warn", "gateway", "Invalid JSON-RPC 2.0 message received");
      return;
    }

    // Push notification (no id, has method)
    if (message.id === undefined && message.method) {
      const params = message.params ?? {};

      // Handle push.executeCommand specially — log and notify user
      if (message.method === "push.executeCommand") {
        const cmd = typeof params.command === "string" ? params.command : "unknown";
        const from = typeof params.fromClientId === "string" ? params.fromClientId : "unknown";
        clientLog("info", "gateway", `Received remote command "${cmd}" from client ${from}`);
      }

      // Dispatch to typed handlers
      const typedHandlers = this.typedPushHandlers.get(message.method);
      if (typedHandlers) {
        for (const handler of typedHandlers) {
          try {
            handler(params);
          } catch (err) {
            clientLog("error", "gateway", "Typed push handler error", err);
          }
        }
      }

      // Dispatch to generic handlers
      for (const handler of this.pushHandlers) {
        try {
          handler(message.method, params);
        } catch (err) {
          clientLog("error", "gateway", "Push handler error", err);
        }
      }
      return;
    }

    // Response to a pending request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        clientLog("warn", "gateway", "Received response for unknown request id", { id: message.id });
        return;
      }

      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timer);

      if (message.error) {
        pending.reject(new Error(`RPC Error (${message.error.code}): ${message.error.message}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private setState(state: ConnectionState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch (err) {
        clientLog("error", "gateway", "State change handler error", err);
      }
    }

    // Phone-home: upload buffered client errors on reconnection
    if (state === "connected") {
      this.flushErrorBuffer();
    }
  }

  /**
   * Send buffered client-side errors to the gateway for diagnostic reporting.
   * Fires after each successful connection and clears the buffer on success.
   */
  private flushErrorBuffer(): void {
    const errors = getRecentErrors();
    if (errors.length === 0) return;

    // Serialize entries (ReadonlyArray -> plain objects for JSON)
    const entries = errors.map((e) => ({
      level: e.level,
      module: e.module,
      message: e.message,
      data: e.data,
      timestamp: e.timestamp,
    }));

    this.call("client.reportErrors", { errors: entries }).then(
      () => {
        clearErrorBuffer();
        clientLog("debug", "gateway", `Flushed ${entries.length} client error(s) to gateway`);
      },
      () => {
        // Best-effort: if RPC fails, keep the buffer for the next attempt
      },
    );
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.setState("error");
      return;
    }

    const baseDelay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts, MAX_RECONNECT_DELAY_MS);
    // Add random jitter (0-25% of base delay) to prevent thundering herd
    const jitter = Math.random() * baseDelay * 0.25;
    const delay = baseDelay + jitter;
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.establishConnection();
      }
    }, delay);
  }

  private rejectAllPending(reason: string): void {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pendingRequests.delete(id);
    }
  }
}
