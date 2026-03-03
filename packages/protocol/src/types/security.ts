/**
 * Security types for action classification, audit logging, and secret management.
 */

export type ActionLevel = "safe" | "needs_approval" | "dangerous";

export interface ActionClassification {
  readonly action: string;
  readonly level: ActionLevel;
  readonly reason: string;
  readonly requiresApproval: boolean;
}

export type AuditResult = "success" | "failure" | "denied";

export interface AuditEvent {
  readonly action: string;
  readonly actor: string;
  readonly target: string;
  readonly result: AuditResult;
  readonly details?: Record<string, unknown>;
  readonly timestamp?: number;
}

export interface AuditEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly result: AuditResult;
  readonly integrityHash: string;
  readonly metadata?: Record<string, unknown>;
}

export interface AuditFilter {
  readonly actor?: string;
  readonly action?: string;
  readonly target?: string;
  readonly result?: AuditResult;
  readonly startTime?: number;
  readonly endTime?: number;
  readonly limit?: number;
  readonly offset?: number;
}

export interface SecretMetadata {
  readonly key: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly accessedAt: number;
  readonly description?: string;
}

// ---------------------------------------------------------------------------
// Approval system types
// ---------------------------------------------------------------------------

export type ApprovalStatus = "pending" | "approved" | "denied" | "timeout" | "escalated";

export type TimeoutAction = "deny" | "approve" | "escalate";

export interface EscalationPolicy {
  /** Time in ms before this escalation level triggers. */
  readonly timeoutMs: number;
  /** What happens when this level times out. */
  readonly action: TimeoutAction;
  /** Channel ID to escalate to (required when action is "escalate"). */
  readonly escalateTo?: string;
  /** Maximum number of escalation steps (default 3). */
  readonly maxEscalations?: number;
}

export interface ApprovalRequest {
  readonly id: string;
  readonly action: string;
  readonly level: ActionLevel;
  readonly description: string;
  readonly requestedAt: number;
  readonly timeoutAt: number;
  readonly channel: string;
  readonly status: ApprovalStatus;
  readonly respondedBy?: string;
  readonly respondedAt?: number;
  readonly escalationLevel: number;
  readonly metadata?: Record<string, unknown>;
}
