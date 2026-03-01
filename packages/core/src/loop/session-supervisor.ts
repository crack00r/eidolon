/**
 * SessionSupervisor -- manages concurrent Claude Code sessions.
 *
 * Enforces per-type concurrency limits and priority-based interruption.
 * Session types with higher priority can interrupt lower-priority interruptible sessions.
 */

import type { EidolonError, Result, SessionType } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

export interface SessionSlot {
  readonly sessionId: string;
  readonly type: SessionType;
  readonly startedAt: number;
  readonly interruptible: boolean;
}

export interface ConcurrencyRule {
  readonly maxConcurrent: number;
  readonly interruptible: boolean;
  readonly priority: number; // higher = more important
}

const CONCURRENCY_RULES: Readonly<Record<SessionType, ConcurrencyRule>> = {
  main: { maxConcurrent: 1, interruptible: false, priority: 100 },
  voice: { maxConcurrent: 1, interruptible: true, priority: 80 },
  task: { maxConcurrent: 3, interruptible: true, priority: 60 },
  review: { maxConcurrent: 1, interruptible: true, priority: 40 },
  learning: { maxConcurrent: 1, interruptible: true, priority: 30 },
  dream: { maxConcurrent: 1, interruptible: true, priority: 10 },
};

export class SessionSupervisor {
  private readonly sessions: Map<string, SessionSlot> = new Map();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child("session-supervisor");
  }

  /** Check if a new session of this type can be started. */
  canStart(type: SessionType): boolean {
    const rule = CONCURRENCY_RULES[type];
    return this.countByType(type) < rule.maxConcurrent;
  }

  /** Register a running session. Returns error if limit exceeded. */
  register(sessionId: string, type: SessionType): Result<void, EidolonError> {
    if (!this.canStart(type)) {
      return Err(
        createError(
          ErrorCode.SESSION_LIMIT_REACHED,
          `Cannot start session "${sessionId}": ${type} limit (${CONCURRENCY_RULES[type].maxConcurrent}) reached`,
        ),
      );
    }

    const rule = CONCURRENCY_RULES[type];
    const slot: SessionSlot = {
      sessionId,
      type,
      startedAt: Date.now(),
      interruptible: rule.interruptible,
    };

    this.sessions.set(sessionId, slot);
    this.logger.info("register", `Session registered: ${sessionId} (${type})`, {
      sessionId,
      type,
      activeCount: this.sessions.size,
    });

    return Ok(undefined);
  }

  /** Unregister a completed session. */
  unregister(sessionId: string): void {
    const slot = this.sessions.get(sessionId);
    if (slot) {
      this.sessions.delete(sessionId);
      this.logger.info("unregister", `Session unregistered: ${sessionId} (${slot.type})`, {
        sessionId,
        type: slot.type,
        activeCount: this.sessions.size,
      });
    }
  }

  /** Get the session that should be interrupted to make room, or null. */
  findInterruptible(forType: SessionType): SessionSlot | null {
    const forPriority = CONCURRENCY_RULES[forType].priority;
    let candidate: SessionSlot | null = null;

    for (const slot of this.sessions.values()) {
      // Only consider interruptible sessions with strictly lower priority
      if (!slot.interruptible) continue;
      if (CONCURRENCY_RULES[slot.type].priority >= forPriority) continue;

      // Pick the lowest-priority candidate
      if (candidate === null || CONCURRENCY_RULES[slot.type].priority < CONCURRENCY_RULES[candidate.type].priority) {
        candidate = slot;
      }
    }

    return candidate;
  }

  /** Get all active sessions. */
  getActive(): readonly SessionSlot[] {
    return [...this.sessions.values()];
  }

  /** Get active sessions by type. */
  getActiveByType(type: SessionType): readonly SessionSlot[] {
    return [...this.sessions.values()].filter((slot) => slot.type === type);
  }

  /** Count active sessions by type. */
  countByType(type: SessionType): number {
    let count = 0;
    for (const slot of this.sessions.values()) {
      if (slot.type === type) count++;
    }
    return count;
  }

  /** Get the concurrency rule for a session type. */
  getRule(type: SessionType): ConcurrencyRule {
    return CONCURRENCY_RULES[type];
  }

  /** Check if any sessions are running. */
  hasActiveSessions(): boolean {
    return this.sessions.size > 0;
  }
}
