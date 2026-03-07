/**
 * MeetingPrepDetector -- detects upcoming meetings with known attendees
 * and suggests preparation by surfacing past conversations.
 */

import type { AnticipationConfig } from "@eidolon/protocol";
import type { KGEntityStore } from "../../memory/knowledge-graph/entities.ts";
import type { MemorySearch } from "../../memory/search.ts";
import type { DetectedPattern, DetectionContext, IPatternDetector } from "../patterns.ts";

const DETECTOR_ID = "meeting_prep";

export class MeetingPrepDetector implements IPatternDetector {
  readonly id = DETECTOR_ID;
  readonly name = "Meeting Preparation";

  private readonly memorySearch: MemorySearch;
  private readonly kgEntityStore: KGEntityStore | null;
  private readonly windowMinutes: number;

  constructor(
    memorySearch: MemorySearch,
    kgEntityStore: KGEntityStore | null,
    config: AnticipationConfig["detectors"]["meetingPrep"],
  ) {
    this.memorySearch = memorySearch;
    this.kgEntityStore = kgEntityStore;
    this.windowMinutes = config.windowMinutes;
  }

  async detect(context: DetectionContext): Promise<DetectedPattern[]> {
    const patterns: DetectedPattern[] = [];
    const windowEnd = context.now + this.windowMinutes * 60_000;

    for (const event of context.upcomingEvents) {
      // Skip all-day events and events outside the window
      if (event.allDay) continue;
      if (event.startTime > windowEnd || event.startTime < context.now) continue;

      // Extract attendee names from event description (simple heuristic)
      const attendeeNames = extractAttendeeNames(event.title, event.description);
      if (attendeeNames.length === 0) continue;

      const relevantEntities: string[] = [];
      let confidence = 0.6;

      for (const name of attendeeNames) {
        // Check if attendee exists in KG
        if (this.kgEntityStore) {
          const entityResult = this.kgEntityStore.findByName(name);
          if (entityResult.ok && entityResult.value) {
            relevantEntities.push(entityResult.value.name);
            confidence = Math.max(confidence, 0.9);
            continue;
          }
        }

        // Fall back to memory search for name mentions
        const searchResult = await this.memorySearch.search({
          text: name,
          limit: 1,
          types: ["episode"],
        });
        if (searchResult.ok && searchResult.value.length > 0) {
          relevantEntities.push(name);
          confidence = Math.max(confidence, 0.6);
        }
      }

      if (relevantEntities.length > 0) {
        patterns.push({
          detectorId: DETECTOR_ID,
          type: "meeting_prep",
          confidence,
          relevantEntities,
          calendarEventId: event.id,
          metadata: {
            eventTitle: event.title,
            startTime: event.startTime,
            minutesUntil: Math.round((event.startTime - context.now) / 60_000),
          },
        });
      }
    }

    return patterns;
  }
}

/**
 * Extract potential attendee names from event title and description.
 * Simple heuristic: looks for patterns like "with X", "Meeting X", etc.
 */
function extractAttendeeNames(title: string, description?: string): string[] {
  const names: string[] = [];
  const text = `${title} ${description ?? ""}`;

  // Pattern: "with Name" or "mit Name" (German)
  const withPattern = /(?:with|mit)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  let match: RegExpExecArray | null = withPattern.exec(text);
  while (match !== null) {
    if (match[1]) names.push(match[1]);
    match = withPattern.exec(text);
  }

  // Pattern: "Name Meeting" or "Meeting Name"
  const meetingPattern = /(?:meeting|call|sync|standup|1:1)\s+(?:with\s+)?([A-Z][a-z]+)/gi;
  match = meetingPattern.exec(text);
  while (match !== null) {
    if (match[1]) names.push(match[1]);
    match = meetingPattern.exec(text);
  }

  return [...new Set(names)];
}
