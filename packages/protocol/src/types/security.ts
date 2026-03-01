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

export interface AuditEntry {
  readonly id: string;
  readonly timestamp: number;
  readonly actor: string;
  readonly action: string;
  readonly target: string;
  readonly result: "success" | "failure" | "denied";
  readonly metadata?: Record<string, unknown>;
}

export interface SecretMetadata {
  readonly key: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly accessedAt: number;
  readonly description?: string;
}
