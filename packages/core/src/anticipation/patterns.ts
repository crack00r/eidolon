/**
 * Pattern detection interfaces for the Anticipation Engine.
 * IPatternDetector is the plugin interface -- exported from @eidolon/protocol
 * types are used here for DetectionContext and DetectedPattern.
 */

import type { CalendarEvent, Memory, PatternType } from "@eidolon/protocol";
import type { UserProfile } from "../memory/profile.ts";

// ---------------------------------------------------------------------------
// Detection Context -- input to all pattern detectors
// ---------------------------------------------------------------------------

export interface DetectionContext {
  readonly now: number;
  readonly profile: UserProfile;
  readonly upcomingEvents: readonly CalendarEvent[];
  readonly recentMemories: readonly Memory[];
  readonly timezone: string;
}

// ---------------------------------------------------------------------------
// Detected Pattern -- output from pattern detectors
// ---------------------------------------------------------------------------

export interface DetectedPattern {
  readonly detectorId: string;
  readonly type: PatternType;
  readonly confidence: number;
  readonly relevantEntities: readonly string[];
  readonly calendarEventId?: string;
  readonly metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// IPatternDetector -- the contract for all detectors (built-in and plugin)
// ---------------------------------------------------------------------------

export interface IPatternDetector {
  readonly id: string;
  readonly name: string;
  detect(context: DetectionContext): Promise<DetectedPattern[]>;
}
