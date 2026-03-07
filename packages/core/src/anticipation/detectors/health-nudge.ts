/**
 * HealthNudgeDetector -- reminds the user about exercise if they have
 * a health/exercise preference but no activity today after a threshold hour.
 */

import type { AnticipationConfig } from "@eidolon/protocol";
import type { DetectedPattern, DetectionContext, IPatternDetector } from "../patterns.ts";

const DETECTOR_ID = "health_nudge";

export class HealthNudgeDetector implements IPatternDetector {
  readonly id = DETECTOR_ID;
  readonly name = "Health Nudge";

  private readonly afterHour: number;
  private readonly activityTags: readonly string[];

  constructor(config: AnticipationConfig["detectors"]["healthNudge"]) {
    this.afterHour = config.afterHour;
    this.activityTags = config.activityTags;
  }

  async detect(context: DetectionContext): Promise<DetectedPattern[]> {
    // Check if user has exercise preferences
    const hasExercisePref = context.profile.preferences.some((p) =>
      this.activityTags.some((tag) => p.key.toLowerCase().includes(tag) || p.value.toLowerCase().includes(tag)),
    );

    if (!hasExercisePref) return [];

    // Check current hour in user's timezone
    const currentHour = getHourInTimezone(context.now, context.timezone);
    if (currentHour < this.afterHour) return [];

    // Check if user already exercised today
    const todayStart = getStartOfDayInTimezone(context.now, context.timezone);
    const hasActivityToday = context.recentMemories.some((m) => {
      if (m.createdAt < todayStart) return false;
      const content = m.content.toLowerCase();
      const tags = m.tags.map((t) => t.toLowerCase());
      return this.activityTags.some((tag) => content.includes(tag) || tags.includes(tag));
    });

    if (hasActivityToday) return [];

    const dateKey = new Date(context.now).toISOString().slice(0, 10);

    return [
      {
        detectorId: DETECTOR_ID,
        type: "health_nudge",
        confidence: 0.7,
        relevantEntities: [],
        metadata: {
          suggestedTime: `${this.afterHour + 1}:00`,
          date: dateKey,
        },
      },
    ];
  }
}

/** Get the current hour in a given IANA timezone. */
function getHourInTimezone(timestamp: number, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    });
    const parts = formatter.formatToParts(new Date(timestamp));
    const hourPart = parts.find((p) => p.type === "hour");
    let hour = hourPart ? Number(hourPart.value) : 0;
    if (hour === 24) hour = 0;
    return hour;
  } catch {
    return new Date(timestamp).getHours();
  }
}

/** Get the start of day (midnight) timestamp in a given timezone. */
function getStartOfDayInTimezone(timestamp: number, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const dateStr = formatter.format(new Date(timestamp));
    return new Date(`${dateStr}T00:00:00`).getTime();
  } catch {
    const d = new Date(timestamp);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}
