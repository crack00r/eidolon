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
  | "command.result"
  // Client phone-home error reporting (alias for error.report)
  | "client.reportErrors"
  // Feedback methods
  | "feedback.submit"
  | "feedback.list"
  // Automation methods (Khoj-style scheduled automations)
  | "automation.create"
  | "automation.list"
  | "automation.delete"
  // Approval methods
  | "approval.list"
  | "approval.respond"
  // Research methods
  | "research.start"
  | "research.status"
  | "research.list"
  // Profile methods
  | "profile.get"
  // Metrics methods
  | "metrics.rateLimits"
  // Calendar methods
  | "calendar.listEvents"
  | "calendar.createEvent"
  | "calendar.deleteEvent"
  | "calendar.sync"
  | "calendar.getUpcoming"
  // GPU pool methods
  | "gpu.workers"
  | "gpu.pool_status";

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
  | "push.approvalRequested"
  | "push.approvalResolved"
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

// ---------------------------------------------------------------------------
// Feedback types
// ---------------------------------------------------------------------------

export interface FeedbackSubmitParams {
  readonly sessionId: string;
  readonly messageId?: string;
  readonly rating: number;
  readonly channel: string;
  readonly comment?: string;
}

export interface FeedbackListParams {
  readonly sessionId?: string;
  readonly limit?: number;
  readonly since?: number;
}

export interface FeedbackEntry {
  readonly id: string;
  readonly sessionId: string;
  readonly messageId: string | undefined;
  readonly rating: number;
  readonly channel: string;
  readonly comment: string | undefined;
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Automation RPC types (Khoj-style scheduled automations)
// ---------------------------------------------------------------------------

export interface AutomationCreateParams {
  /** Natural language description of the automation schedule and task. */
  readonly input: string;
  /** Optional channel override for result delivery. */
  readonly deliverTo?: string;
}

export interface AutomationListParams {
  /** If true, only return enabled automations. */
  readonly enabledOnly?: boolean;
}

export interface AutomationDeleteParams {
  /** ID of the automation to delete. */
  readonly automationId: string;
}

// ---------------------------------------------------------------------------
// Approval types
// ---------------------------------------------------------------------------

export interface ApprovalListParams {
  /** Filter by status. If omitted, returns "pending" requests. */
  readonly status?: string;
  readonly limit?: number;
}

export interface ApprovalRespondParams {
  /** The approval request ID. */
  readonly requestId: string;
  /** Whether to approve or deny. */
  readonly approved: boolean;
}

export interface PushApprovalRequestedPayload {
  readonly requestId: string;
  readonly action: string;
  readonly level: string;
  readonly description: string;
  readonly channel: string;
  readonly timeoutAt: number;
  readonly escalationLevel: number;
  readonly timestamp: number;
}

export interface PushApprovalResolvedPayload {
  readonly requestId: string;
  readonly action: string;
  readonly status: string;
  readonly respondedBy?: string;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Research types
// ---------------------------------------------------------------------------

export interface ResearchStartParams {
  /** The research query. */
  readonly query: string;
  /** Sources to search (e.g., "web", "academic", "github"). Defaults to all. */
  readonly sources?: readonly string[];
  /** Maximum number of sources to consult. */
  readonly maxSources?: number;
  /** Optional channel to deliver the result to. */
  readonly deliverTo?: string;
}

export interface ResearchStatusParams {
  /** The research session ID. */
  readonly researchId: string;
}

export interface ResearchListParams {
  /** Maximum number of results to return. */
  readonly limit?: number;
  /** Only return results after this timestamp. */
  readonly since?: number;
}

// ---------------------------------------------------------------------------
// Discovery & Pairing types
// ---------------------------------------------------------------------------

export interface DiscoveryBeacon {
  readonly service: "eidolon";
  readonly version: string;
  readonly hostname: string;
  readonly host: string;
  readonly port: number;
  readonly tailscaleIp?: string;
  readonly tls: boolean;
  readonly role: "server";
  readonly startedAt: number;
}

export interface ServerInfo {
  readonly hostname: string;
  readonly host: string;
  readonly port: number;
  readonly version: string;
  readonly tailscaleIp?: string;
  readonly tls: boolean;
  readonly uptime: number;
  readonly connectedClients: number;
  readonly memoryCount: number;
}

export interface PairingUrl {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly tls: boolean;
  readonly tailscaleIp?: string;
  readonly version: string;
}
