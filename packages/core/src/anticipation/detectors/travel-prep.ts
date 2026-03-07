/**
 * TravelPrepDetector -- detects upcoming travel by checking calendar events
 * for location fields that differ from the user's home city.
 */

import type { AnticipationConfig } from "@eidolon/protocol";
import type { DetectedPattern, DetectionContext, IPatternDetector } from "../patterns.ts";

const DETECTOR_ID = "travel_prep";

/** Keywords that suggest travel when found in event title or description. */
const TRAVEL_KEYWORDS = [
  "trip",
  "travel",
  "flight",
  "train",
  "hotel",
  "reise",
  "flug",
  "zug",
  "airport",
  "bahnhof",
  "anreise",
  "abreise",
];

export class TravelPrepDetector implements IPatternDetector {
  readonly id = DETECTOR_ID;
  readonly name = "Travel Preparation";

  private readonly windowHours: number;
  private readonly homeCity: string;

  constructor(config: AnticipationConfig["detectors"]["travelPrep"]) {
    this.windowHours = config.windowHours;
    this.homeCity = config.homeCity.toLowerCase();
  }

  async detect(context: DetectionContext): Promise<DetectedPattern[]> {
    const patterns: DetectedPattern[] = [];
    const windowEnd = context.now + this.windowHours * 3_600_000;

    for (const event of context.upcomingEvents) {
      if (event.startTime > windowEnd || event.startTime < context.now) continue;

      const location = event.location?.trim() ?? "";
      const hasExplicitLocation = location.length > 0;
      const title = event.title.toLowerCase();
      const description = (event.description ?? "").toLowerCase();

      // Skip if location matches home city
      if (hasExplicitLocation && this.homeCity && location.toLowerCase().includes(this.homeCity)) {
        continue;
      }

      let confidence = 0;
      const metadata: Record<string, unknown> = {
        eventTitle: event.title,
        startTime: event.startTime,
      };

      if (hasExplicitLocation) {
        // Explicit location that differs from home city
        confidence = 0.85;
        metadata.destination = location;
      } else {
        // Check for travel keywords in title/description
        const hasKeyword = TRAVEL_KEYWORDS.some((kw) => title.includes(kw) || description.includes(kw));
        if (hasKeyword) {
          confidence = 0.5;
        }
      }

      if (confidence > 0) {
        patterns.push({
          detectorId: DETECTOR_ID,
          type: "travel_prep",
          confidence,
          relevantEntities: hasExplicitLocation ? [location] : [],
          calendarEventId: event.id,
          metadata,
        });
      }
    }

    return patterns;
  }
}
