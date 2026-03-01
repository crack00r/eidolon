/**
 * Session types and metadata for Claude Code subprocess sessions.
 */

export type SessionType = "main" | "task" | "learning" | "dream" | "voice" | "review";

export interface SessionInfo {
  readonly id: string;
  readonly type: SessionType;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly tokensUsed: number;
  readonly status: "running" | "paused" | "completed" | "failed";
  readonly claudeSessionId?: string;
}
