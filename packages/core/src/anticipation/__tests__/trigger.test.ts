import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { AnticipationConfig } from "@eidolon/protocol";
import { AnticipationConfigSchema } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { SuggestionHistory } from "../history.ts";
import type { DetectedPattern } from "../patterns.ts";
import { buildEntityKey, TriggerEvaluator } from "../trigger.ts";

const logger = createLogger({ level: "error", directory: "", format: "json", maxSizeMb: 10, maxFiles: 1 });

function makeConfig(overrides: Partial<AnticipationConfig> = {}): AnticipationConfig {
  return AnticipationConfigSchema.parse({ enabled: true, ...overrides });
}

function makeHistory(): { history: SuggestionHistory; db: Database } {
  const db = new Database(":memory:");
  const history = new SuggestionHistory(db, logger);
  return { history, db };
}

function makePattern(overrides: Partial<DetectedPattern> = {}): DetectedPattern {
  return {
    detectorId: "test",
    type: "meeting_prep",
    confidence: 0.9,
    relevantEntities: ["Anna"],
    calendarEventId: "evt-1",
    metadata: {},
    ...overrides,
  };
}

describe("TriggerEvaluator", () => {
  test("passes patterns above confidence threshold", () => {
    const { history } = makeHistory();
    const config = makeConfig({ minConfidence: 0.6 });
    const evaluator = new TriggerEvaluator(history, config, logger);

    const patterns = [makePattern({ confidence: 0.9 }), makePattern({ confidence: 0.5 })];

    const result = evaluator.evaluate(patterns);
    expect(result.length).toBe(1);
    expect(result[0]?.confidence).toBe(0.9);
  });

  test("enforces cooldown", () => {
    const { history } = makeHistory();
    const config = makeConfig({ cooldownMinutes: 240 });
    const evaluator = new TriggerEvaluator(history, config, logger);

    // Record a recent suggestion
    history.record({
      patternType: "meeting_prep",
      detectorId: "test",
      entityKey: "meeting:evt-1",
      confidence: 0.9,
      suggestionTitle: "Meeting prep",
      channelId: "telegram",
    });

    const patterns = [makePattern({ calendarEventId: "evt-1" })];
    const result = evaluator.evaluate(patterns);
    expect(result.length).toBe(0);
  });

  test("enforces rate limit", () => {
    const { history } = makeHistory();
    const config = makeConfig({ maxSuggestionsPerHour: 2 });
    const evaluator = new TriggerEvaluator(history, config, logger);

    // Record 2 suggestions within the last hour
    history.record({
      patternType: "health_nudge",
      detectorId: "health",
      entityKey: "health:2026-03-07",
      confidence: 0.7,
      suggestionTitle: "Training",
      channelId: "telegram",
    });
    history.record({
      patternType: "follow_up",
      detectorId: "followup",
      entityKey: "followup:mem-1",
      confidence: 0.75,
      suggestionTitle: "Follow up",
      channelId: "telegram",
    });

    const patterns = [makePattern({ type: "birthday_reminder", calendarEventId: undefined })];
    const result = evaluator.evaluate(patterns);
    expect(result.length).toBe(0);
  });

  test("applies suppression", () => {
    const { history, db } = makeHistory();
    const config = makeConfig();
    const evaluator = new TriggerEvaluator(history, config, logger);

    // Add manual suppression
    db.run(
      `INSERT INTO anticipation_suppressions (id, pattern_type, entity_key, suppressed_at, expires_at, reason)
       VALUES ('s1', 'meeting_prep', NULL, ?, NULL, 'user_explicit')`,
      [Date.now()],
    );

    const patterns = [makePattern()];
    const result = evaluator.evaluate(patterns);
    expect(result.length).toBe(0);
  });

  test("reduces confidence based on feedback", () => {
    const { history } = makeHistory();
    const config = makeConfig({ minConfidence: 0.7 });
    const evaluator = new TriggerEvaluator(history, config, logger);

    // Record 3 irrelevant feedbacks
    for (let i = 0; i < 3; i++) {
      const record = history.record({
        patternType: "meeting_prep",
        detectorId: "test",
        entityKey: `meeting:old-${i}`,
        confidence: 0.9,
        suggestionTitle: "Old meeting",
        channelId: "telegram",
      });
      history.recordFeedback(record.id, "irrelevant");
    }

    // Pattern at 0.9 confidence should be reduced by 0.3 to 0.6, below threshold
    const patterns = [makePattern({ confidence: 0.9, calendarEventId: "evt-new" })];
    const result = evaluator.evaluate(patterns);
    expect(result.length).toBe(0);
  });

  test("allows different entity keys even if same pattern type", () => {
    const { history } = makeHistory();
    const config = makeConfig({ cooldownMinutes: 240 });
    const evaluator = new TriggerEvaluator(history, config, logger);

    history.record({
      patternType: "meeting_prep",
      detectorId: "test",
      entityKey: "meeting:evt-1",
      confidence: 0.9,
      suggestionTitle: "Meeting 1",
      channelId: "telegram",
    });

    // Different event ID should not be blocked by cooldown
    const patterns = [makePattern({ calendarEventId: "evt-2" })];
    const result = evaluator.evaluate(patterns);
    expect(result.length).toBe(1);
  });
});

describe("buildEntityKey", () => {
  test("builds correct keys for each pattern type", () => {
    expect(buildEntityKey(makePattern({ type: "meeting_prep", calendarEventId: "e1" }))).toBe("meeting:e1");
    expect(buildEntityKey(makePattern({ type: "travel_prep", calendarEventId: "e2" }))).toBe("travel:e2");
    expect(
      buildEntityKey(
        makePattern({
          type: "health_nudge",
          metadata: { date: "2026-03-07" },
        }),
      ),
    ).toBe("health:2026-03-07");
    expect(
      buildEntityKey(
        makePattern({
          type: "follow_up",
          metadata: { memoryId: "m1" },
        }),
      ),
    ).toBe("followup:m1");
    expect(
      buildEntityKey(
        makePattern({
          type: "birthday_reminder",
          relevantEntities: ["Maria"],
        }),
      ),
    ).toBe("birthday:Maria");
  });
});
