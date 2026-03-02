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
