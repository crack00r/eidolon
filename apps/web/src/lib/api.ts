/**
 * WebSocket client for communicating with the Eidolon Core gateway.
 * Uses JSON-RPC 2.0 protocol over WebSocket on port 8419.
 *
 * Web-specific variant: uses sessionStorage for token persistence
 * (cleared on tab close), supports wss:// by default, no Tauri APIs.
 */

export interface GatewayConfig {
  host: string;
  port: number;
  token?: string;
  useTls?: boolean;
}

export type ConnectionState = "disconnected" | "connecting" | "authenticating" | "connected" | "error";

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
        this.ws!.send(JSON.stringify(request));
      } catch (sendErr) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(sendErr instanceof Error ? sendErr : new Error("WebSocket send failed"));
      }
    });
  }

  onPush(handler: (method: string, params: Record<string, unknown>) => void): () => void {
    this.pushHandlers.add(handler);
    return () => {
      this.pushHandlers.delete(handler);
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
      console.error("Invalid hostname:", this.config.host);
      this.setState("error");
      return;
    }

    const scheme = this.config.useTls !== false ? "wss" : "ws";
    const url = `${scheme}://${this.config.host}:${this.config.port}/ws`;

    try {
      this.ws = new WebSocket(url);
    } catch {
      this.setState("error");
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = (): void => {
      this.reconnectAttempts = 0;

      if (this.config.token) {
        this.setState("authenticating");
        this.sendAuth();
      } else {
        this.setState("connected");
      }
    };

    this.ws.onmessage = (event: MessageEvent): void => {
      // Ignore binary frames — we only handle JSON text messages
      if (typeof event.data !== "string") return;
      this.handleMessage(event.data);
    };

    this.ws.onclose = (): void => {
      this.ws = null;
      this.rejectAllPending("Connection closed");

      if (this.shouldReconnect) {
        this.setState("disconnected");
        this.scheduleReconnect();
      } else {
        this.setState("disconnected");
      }
    };

    this.ws.onerror = (): void => {
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
      params: { token: this.config.token },
    };

    const timer = setTimeout(() => {
      this.pendingRequests.delete(id);
      this.setState("error");
      this.ws?.close(4001, "Auth timeout");
    }, DEFAULT_TIMEOUT_MS);

    this.pendingRequests.set(id, {
      resolve: (): void => {
        this.setState("connected");
      },
      reject: (err: Error): void => {
        this.setState("error");
        console.error("Authentication failed:", err.message);
        this.ws?.close(4002, "Auth failed");
      },
      timer,
    });

    this.ws.send(JSON.stringify(authRequest));
  }

  private handleMessage(data: string): void {
    // Guard against oversized messages to prevent memory exhaustion
    if (data.length > MAX_MESSAGE_SIZE) {
      console.warn("Gateway message too large, dropping:", data.length, "bytes");
      return;
    }

    let message: JsonRpcResponse;
    try {
      message = JSON.parse(data) as JsonRpcResponse;
    } catch {
      console.error("Failed to parse gateway message");
      return;
    }

    // Validate JSON-RPC 2.0 envelope
    if (
      message.jsonrpc !== "2.0" ||
      (message.result === undefined && message.error === undefined && message.method === undefined)
    ) {
      console.warn("Invalid JSON-RPC 2.0 message received");
      return;
    }

    // Push notification (no id, has method)
    if (message.id === undefined && message.method) {
      const params = message.params ?? {};
      for (const handler of this.pushHandlers) {
        try {
          handler(message.method, params);
        } catch (err) {
          console.error("Push handler error:", err);
        }
      }
      return;
    }

    // Response to a pending request
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        console.warn("Received response for unknown request id:", message.id);
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
        console.error("State change handler error:", err);
      }
    }
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
