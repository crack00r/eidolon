import { describe, expect, test } from "bun:test";
import { AnticipationConfigSchema } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { ActionComposer } from "../composer.ts";
import type { EnrichedContext } from "../enricher.ts";
import type { DetectedPattern } from "../patterns.ts";

const logger = createLogger({ level: "error", directory: "", format: "json", maxSizeMb: 10, maxFiles: 1 });
const config = AnticipationConfigSchema.parse({ enabled: true });

function makeEnrichedContext(
  overrides: {
    pattern?: Partial<DetectedPattern>;
    relatedMemories?: EnrichedContext["relatedMemories"];
    calendarContext?: string;
  } = {},
): EnrichedContext {
  return {
    pattern: {
      detectorId: "test",
      type: "meeting_prep",
      confidence: 0.9,
      relevantEntities: ["Anna"],
      calendarEventId: "evt-1",
      metadata: {
        eventTitle: "Sync with Anna",
        minutesUntil: 30,
      },
      ...overrides.pattern,
    },
    relatedMemories: overrides.relatedMemories ?? [],
    calendarContext: overrides.calendarContext ?? "",
  };
}

describe("ActionComposer", () => {
  test("composes meeting_prep template correctly", async () => {
    const composer = new ActionComposer(config, logger);
    const ctx = makeEnrichedContext();
    const suggestion = await composer.compose(ctx);

    expect(suggestion.patternType).toBe("meeting_prep");
    expect(suggestion.title).toContain("Anna");
    expect(suggestion.title).toContain("30");
    expect(suggestion.channelId).toBe("telegram");
    expect(suggestion.priority).toBe("normal");
    expect(suggestion.actionable).toBe(false);
  });

  test("sets critical priority for imminent meetings", async () => {
    const composer = new ActionComposer(config, logger);
    const ctx = makeEnrichedContext({
      pattern: { metadata: { eventTitle: "Urgent", minutesUntil: 10 } },
    });

    const suggestion = await composer.compose(ctx);
    expect(suggestion.priority).toBe("critical");
  });

  test("handles missing metadata fields gracefully", async () => {
    const composer = new ActionComposer(config, logger);
    const ctx = makeEnrichedContext({
      pattern: { metadata: {}, type: "follow_up" },
    });

    const suggestion = await composer.compose(ctx);
    expect(suggestion.patternType).toBe("follow_up");
    expect(suggestion.title).toBe("Follow-Up Erinnerung");
    expect(suggestion.actionable).toBe(true);
    expect(suggestion.suggestedAction).toBe("Jetzt erledigen");
  });

  test("composes health_nudge with action suggestion", async () => {
    const composer = new ActionComposer(config, logger);
    const ctx = makeEnrichedContext({
      pattern: {
        type: "health_nudge",
        detectorId: "health",
        metadata: { suggestedTime: "18:00" },
        relevantEntities: [],
      },
    });

    const suggestion = await composer.compose(ctx);
    expect(suggestion.actionable).toBe(true);
    expect(suggestion.suggestedAction).toContain("18:00");
    expect(suggestion.body).toContain("trainiert");
  });
});
