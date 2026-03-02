/**
 * Gateway types for JSON-RPC client communication over WebSocket.
 */

// ---------------------------------------------------------------------------
// RPC methods (client → server requests that expect a response)
// ---------------------------------------------------------------------------

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
  | "system.subscribe"
  | "error.report"
  | "voice.start"
  | "voice.stop"
  // Brain control methods (client → server)
  | "brain.pause"
  | "brain.resume"
  | "brain.triggerAction"
  | "brain.getLog"
  // Client management methods
  | "client.list"
  | "client.execute"
  // Command result reporting (target client → server after push.executeCommand)
  | "command.result";

// ---------------------------------------------------------------------------
// Push notification types (server → client, no response expected)
// ---------------------------------------------------------------------------

export type GatewayPushType =
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

// ---------------------------------------------------------------------------
// JSON-RPC message types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Client metadata tracked on the server side
// ---------------------------------------------------------------------------

export interface ConnectedClientInfo {
  readonly id: string;
  readonly platform: string;
  readonly version: string;
  readonly connectedAt: number;
  readonly subscribed: boolean;
}

// ---------------------------------------------------------------------------
// Params / payloads for specific RPC methods
// ---------------------------------------------------------------------------

export interface BrainTriggerActionParams {
  readonly action: string;
  readonly args?: Record<string, unknown>;
}

export interface BrainGetLogParams {
  readonly limit?: number;
}

export interface ClientExecuteParams {
  readonly targetClientId: string;
  readonly command: string;
  readonly args?: unknown;
}

export interface CommandResultParams {
  readonly commandId: string;
  readonly success: boolean;
  readonly result?: unknown;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// Push event payloads
// ---------------------------------------------------------------------------

export interface PushStateChangePayload {
  readonly previousState: string;
  readonly currentState: string;
  readonly timestamp: number;
}

export interface PushTaskPayload {
  readonly taskId: string;
  readonly taskType: string;
  readonly description?: string;
  readonly timestamp: number;
  readonly result?: unknown;
}

export interface PushMemoryCreatedPayload {
  readonly memoryId: string;
  readonly memoryType: string;
  readonly summary: string;
  readonly timestamp: number;
}

export interface PushLearningDiscoveryPayload {
  readonly discoveryId: string;
  readonly source: string;
  readonly title: string;
  readonly relevanceScore: number;
  readonly timestamp: number;
}

export interface PushEnergyUpdatePayload {
  readonly current: number;
  readonly max: number;
  readonly timestamp: number;
}

export interface PushErrorPayload {
  readonly message: string;
  readonly code?: string;
  readonly severity: "warning" | "error" | "critical";
  readonly timestamp: number;
}

export interface PushClientEventPayload {
  readonly clientId: string;
  readonly platform: string;
  readonly version: string;
  readonly timestamp: number;
}

export interface PushExecuteCommandPayload {
  readonly commandId: string;
  readonly command: string;
  readonly args?: unknown;
  readonly fromClientId: string;
}
