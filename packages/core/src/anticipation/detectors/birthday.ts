/**
 * BirthdayDetector -- detects upcoming birthdays from KG relations
 * with type "birthday" or "born_on".
 */

import type { AnticipationConfig } from "@eidolon/protocol";
import type { KGEntityStore } from "../../memory/knowledge-graph/entities.ts";
import type { KGRelationStore } from "../../memory/knowledge-graph/relations.ts";
import type { DetectedPattern, DetectionContext, IPatternDetector } from "../patterns.ts";

const DETECTOR_ID = "birthday";

const BIRTHDAY_PREDICATES = ["birthday", "born_on"];

export class BirthdayDetector implements IPatternDetector {
  readonly id = DETECTOR_ID;
  readonly name = "Birthday Reminder";

  private readonly kgEntityStore: KGEntityStore | null;
  private readonly kgRelationStore: KGRelationStore | null;
  private readonly daysBefore: number;

  constructor(
    kgEntityStore: KGEntityStore | null,
    kgRelationStore: KGRelationStore | null,
    config: AnticipationConfig["detectors"]["birthday"],
  ) {
    this.kgEntityStore = kgEntityStore;
    this.kgRelationStore = kgRelationStore;
    this.daysBefore = config.daysBefore;
  }

  async detect(context: DetectionContext): Promise<DetectedPattern[]> {
    if (!this.kgEntityStore || !this.kgRelationStore) return [];

    const patterns: DetectedPattern[] = [];

    // Get all person entities
    const personsResult = this.kgEntityStore.findByType("person", 200);
    if (!personsResult.ok) return [];

    for (const person of personsResult.value) {
      // Check relations for birthday info
      const relationsResult = this.kgRelationStore.findBySubject(person.id);
      if (!relationsResult.ok) continue;

      for (const relation of relationsResult.value) {
        if (!BIRTHDAY_PREDICATES.includes(relation.type)) continue;

        // The target entity or relation attributes should contain a date
        const targetEntity = this.kgEntityStore.get(relation.targetId);
        const dateStr = targetEntity.ok && targetEntity.value
          ? extractDateFromEntity(targetEntity.value.name, targetEntity.value.attributes)
          : null;

        if (!dateStr) continue;

        if (isWithinDays(dateStr, context.now, this.daysBefore, context.timezone)) {
          patterns.push({
            detectorId: DETECTOR_ID,
            type: "birthday_reminder",
            confidence: 0.95,
            relevantEntities: [person.name],
            metadata: {
              personName: person.name,
              personId: person.id,
              birthdayDate: dateStr,
            },
          });
        }
      }
    }

    return patterns;
  }
}

/** Extract a MM-DD or YYYY-MM-DD date string from entity name or attributes. */
function extractDateFromEntity(
  name: string,
  attributes: Record<string, unknown>,
): string | null {
  // Check attributes for "date", "birthday", "born_on"
  for (const key of ["date", "birthday", "born_on"]) {
    const val = attributes[key];
    if (typeof val === "string" && val.length >= 5) return val;
  }

  // Try parsing entity name as a date (e.g., "1990-03-15" or "03-15")
  const datePattern = /(\d{4}-)?(\d{2})-(\d{2})/;
  const dateMatch = datePattern.exec(name);
  if (dateMatch) return name;

  return null;
}

/** Check if a birthday date (MM-DD or YYYY-MM-DD) falls within N days of now. */
function isWithinDays(
  dateStr: string,
  nowMs: number,
  daysBefore: number,
  timezone: string,
): boolean {
  // Extract month and day
  const pattern = /(?:\d{4}-)?(\d{2})-(\d{2})/;
  const match = pattern.exec(dateStr);
  if (!match || !match[1] || !match[2]) return false;

  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const now = new Date(nowMs);
  let currentYear: number;
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
    });
    const parts = formatter.formatToParts(now);
    currentYear = Number(parts.find((p) => p.type === "year")?.value ?? now.getFullYear());
  } catch {
    currentYear = now.getFullYear();
  }

  // Build this year's birthday date
  const birthdayThisYear = new Date(currentYear, month - 1, day).getTime();
  const birthdayNextYear = new Date(currentYear + 1, month - 1, day).getTime();

  const windowMs = (daysBefore + 1) * 86_400_000;

  // Check if birthday is within the window (handles Dec->Jan wrapping)
  const diffThisYear = birthdayThisYear - nowMs;
  const diffNextYear = birthdayNextYear - nowMs;

  return (
    (diffThisYear >= 0 && diffThisYear <= windowMs) ||
    (diffNextYear >= 0 && diffNextYear <= windowMs)
  );
}
