/**
 * Home Automation types for Advanced HA integration.
 *
 * Provides typed interfaces for entity management, security policies,
 * scenes, state change tracking, and anomaly detection.
 */

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

export interface HAEntity {
  readonly entityId: string;
  readonly domain: string;
  readonly friendlyName: string;
  readonly state: string;
  readonly attributes: Record<string, unknown>;
  readonly lastChanged: number;
}

// ---------------------------------------------------------------------------
// Security policy types
// ---------------------------------------------------------------------------

export type HASecurityLevel = "safe" | "needs_approval" | "dangerous";

export interface HADomainPolicy {
  readonly domain: string;
  readonly level: HASecurityLevel;
  readonly exceptions?: Record<string, HASecurityLevel>;
}

// ---------------------------------------------------------------------------
// Scene types
// ---------------------------------------------------------------------------

export interface HAScene {
  readonly id: string;
  readonly name: string;
  readonly actions: readonly HASceneAction[];
  readonly createdAt: number;
  readonly lastExecutedAt?: number;
}

export interface HASceneAction {
  readonly entityId: string;
  readonly domain: string;
  readonly service: string;
  readonly data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// State change tracking
// ---------------------------------------------------------------------------

export interface HAStateChange {
  readonly entityId: string;
  readonly oldState: string;
  readonly newState: string;
  readonly timestamp: number;
}

// ---------------------------------------------------------------------------
// Anomaly detection
// ---------------------------------------------------------------------------

export interface HAAnomalyRule {
  /** Glob pattern matched against entity IDs (e.g. "light.*", "sensor.temperature_*"). Uses glob matching, NOT regex. */
  readonly entityPattern: string;
  readonly condition: string;
  readonly message: string;
}

export interface HAAnomaly {
  readonly entityId: string;
  readonly friendlyName: string;
  readonly rule: HAAnomalyRule;
  readonly detectedAt: number;
  readonly currentState: string;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// Service execution result
// ---------------------------------------------------------------------------

export interface HAServiceResult {
  readonly entityId: string;
  readonly domain: string;
  readonly service: string;
  readonly success: boolean;
  readonly error?: string;
}

// ---------------------------------------------------------------------------
// State history entry
// ---------------------------------------------------------------------------

export interface HAStateHistoryEntry {
  readonly entityId: string;
  readonly state: string;
  readonly timestamp: number;
}
