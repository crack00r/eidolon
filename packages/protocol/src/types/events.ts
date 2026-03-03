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
  | "gateway:client_connected"
  | "gateway:client_disconnected"
  | "gateway:client_error_report";

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
