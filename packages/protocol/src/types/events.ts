/**
 * Event Bus event types for the Cognitive Loop.
 * All inter-component communication flows through typed events.
 */

import type { SessionType } from "./sessions.ts";

export type EventPriority = "critical" | "high" | "normal" | "low";

export type EventType =
  | "user:message"
  | "user:voice"
  | "user:approval"
  | "user:feedback"
  | "system:startup"
  | "system:shutdown"
  | "system:health_check"
  | "system:config_changed"
  | "memory:extracted"
  | "memory:dream_start"
  | "memory:dream_complete"
  | "learning:discovery"
  | "learning:approved"
  | "learning:rejected"
  | "learning:implemented"
  | "session:started"
  | "session:completed"
  | "session:failed"
  | "session:budget_warning"
  | "channel:connected"
  | "channel:disconnected"
  | "channel:error"
  | "scheduler:task_due"
  | "scheduler:automation_due"
  | "gateway:client_connected"
  | "gateway:client_disconnected"
  | "gateway:client_error_report"
  | "gateway:client_execute"
  | "digest:generate"
  | "digest:delivered"
  | "approval:requested"
  | "approval:timeout"
  | "approval:escalated"
  | "webhook:received"
  | "research:started"
  | "research:completed"
  | "research:failed"
  | "calendar:event_upcoming"
  | "calendar:event_created"
  | "calendar:conflict_detected"
  | "calendar:sync_completed"
  | "ha:state_changed"
  | "ha:anomaly_detected"
  | "ha:scene_executed"
  | "plugin:loaded"
  | "plugin:started"
  | "plugin:stopped"
  | "plugin:error"
  | "anticipation:check"
  | "anticipation:suggestion"
  | "anticipation:dismissed"
  | "anticipation:acted"
  | "workflow:trigger"
  | "workflow:step_ready"
  | "workflow:step_completed"
  | "workflow:step_failed"
  | "workflow:completed"
  | "workflow:failed"
  | "workflow:cancelled";

export interface BusEvent<T = unknown> {
  readonly id: string;
  readonly type: EventType;
  readonly priority: EventPriority;
  readonly payload: T;
  readonly timestamp: number;
  readonly source: string;
  readonly processedAt?: number;
}

export interface UserMessagePayload {
  readonly channelId: string;
  readonly userId: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<{
    readonly type: string;
    readonly url: string;
  }>;
}

export interface UserVoicePayload {
  readonly channelId: string;
  readonly userId: string;
  /** Base64-encoded audio data. */
  readonly audioBase64?: string;
  /** MIME type of the audio (e.g. "audio/wav", "audio/opus"). */
  readonly mimeType?: string;
  /** Pre-transcribed text (if STT was done client-side). */
  readonly text?: string;
}

export interface MemoryExtractedPayload {
  readonly sessionId: string;
  readonly memoryIds: readonly string[];
  readonly count: number;
}

export interface DiscoveryPayload {
  readonly discoveryId: string;
  readonly source: string;
  readonly title: string;
  readonly relevanceScore: number;
}

export interface SessionEventPayload {
  readonly sessionId: string;
  readonly sessionType: SessionType;
  readonly reason?: string;
}

export interface FeedbackReceivedPayload {
  readonly feedbackId: string;
  readonly sessionId: string;
  readonly messageId: string | undefined;
  readonly rating: number;
  readonly channel: string;
}

export interface ApprovalRequestedPayload {
  readonly requestId: string;
  readonly action: string;
  readonly level: string;
  readonly description: string;
  readonly channel: string;
  readonly timeoutAt: number;
}

export interface ApprovalTimeoutPayload {
  readonly requestId: string;
  readonly action: string;
  readonly timeoutAction: string;
  readonly escalationLevel: number;
}

export interface ApprovalEscalatedPayload {
  readonly requestId: string;
  readonly action: string;
  readonly fromChannel: string;
  readonly toChannel: string;
  readonly escalationLevel: number;
}

export interface AutomationDuePayload {
  readonly automationId: string;
  readonly name: string;
  readonly prompt: string;
  readonly deliverTo: string;
}

export interface WebhookReceivedPayload {
  readonly webhookId: string;
  readonly endpointId: string;
  readonly source: string;
  readonly event: string;
  readonly data: Record<string, unknown>;
}

export interface ResearchStartedPayload {
  readonly researchId: string;
  readonly query: string;
  readonly sources: readonly string[];
}

export interface ResearchCompletedPayload {
  readonly researchId: string;
  readonly query: string;
  readonly findingCount: number;
  readonly citationCount: number;
  readonly tokensUsed: number;
  readonly durationMs: number;
}

export interface ResearchFailedPayload {
  readonly researchId: string;
  readonly query: string;
  readonly error: string;
}

// ---------------------------------------------------------------------------
// Anticipation event payloads
// ---------------------------------------------------------------------------

export type PatternType =
  | "meeting_prep"
  | "travel_prep"
  | "health_nudge"
  | "follow_up"
  | "birthday_reminder"
  | "routine_deviation"
  | "commute_alert";

export type AnticipationFeedback = "helpful" | "irrelevant" | "annoying";

export interface AnticipationSuggestionPayload {
  readonly suggestionId: string;
  readonly patternType: PatternType;
  readonly title: string;
  readonly body: string;
  readonly channelId: string;
  readonly priority: "critical" | "high" | "normal" | "low";
  readonly actionable: boolean;
  readonly suggestedAction?: string;
  readonly calendarEventId?: string;
  readonly entityKey: string;
  readonly confidence: number;
}

export interface AnticipationFeedbackPayload {
  readonly suggestionId: string;
  readonly feedback: AnticipationFeedback;
}
