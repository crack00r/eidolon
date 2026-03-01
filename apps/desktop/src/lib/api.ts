/**
 * WebSocket client for communicating with the Eidolon Core gateway.
 * Uses JSON-RPC 2.0 protocol over WebSocket on port 8419.
 */

export interface GatewayConfig {
  host: string;
  port: number;
  token?: string;
  useTls?: boolean;
}

export type ConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "error";

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

      this.ws!.send(JSON.stringify(request));
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

    const scheme = this.config.useTls !== false ? "wss" : "ws";
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

      if (this.config.token) {
        this.setState("authenticating");
        this.sendAuth();
      } else {
        this.setState("connected");
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      this.handleMessage(event.data as string);
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
      params: { token: this.config.token },
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
        console.error("Authentication failed:", err.message);
        this.ws?.close(4002, "Auth failed");
      },
      timer,
    });

    this.ws.send(JSON.stringify(authRequest));
  }

  private handleMessage(data: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(data) as JsonRpcResponse;
    } catch {
      console.error("Failed to parse gateway message:", data);
      return;
    }

    // Validate JSON-RPC 2.0 envelope
    if (
      message.jsonrpc !== "2.0" ||
      (message.result === undefined && message.error === undefined && message.method === undefined)
    ) {
      console.warn("Invalid JSON-RPC 2.0 message received, ignoring:", data);
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
        pending.reject(
          new Error(`RPC Error (${message.error.code}): ${message.error.message}`),
        );
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

    const delay = Math.min(
      BASE_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS,
    );
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
