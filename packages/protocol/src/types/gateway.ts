/**
 * Gateway types for JSON-RPC client communication over WebSocket.
 */

export type GatewayMethod =
  | "chat.send"
  | "chat.stream"
  | "memory.search"
  | "memory.delete"
  | "session.list"
  | "session.info"
  | "learning.list"
  | "learning.approve"
  | "learning.reject"
  | "system.status"
  | "system.health"
  | "voice.start"
  | "voice.stop";

export interface GatewayRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: GatewayMethod;
  readonly params?: Record<string, unknown>;
}

export interface GatewayResponse {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export interface GatewayPushEvent {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface ClientAuth {
  readonly type: "token";
  readonly token: string;
}
