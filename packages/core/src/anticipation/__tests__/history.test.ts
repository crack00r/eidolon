import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createLogger } from "../../logging/logger.ts";
import { SuggestionHistory } from "../history.ts";

const logger = createLogger({ level: "error", directory: "", format: "json", maxSizeMb: 10, maxFiles: 1 });

function createHistory(): { history: SuggestionHistory; db: Database } {
  const db = new Database(":memory:");
  const history = new SuggestionHistory(db, logger);
  return { history, db };
}

describe("SuggestionHistory", () => {
  test("records and retrieves suggestions", () => {
    const { history } = createHistory();

    const record = history.record({
      patternType: "meeting_prep",
      detectorId: "meeting_prep",
      entityKey: "meeting:evt-1",
      confidence: 0.9,
      suggestionTitle: "Meeting with Anna",
      channelId: "telegram",
    });

    expect(record.id).toBeTruthy();
    expect(record.patternType).toBe("meeting_prep");
    expect(record.feedback).toBeNull();

    const recent = history.getRecent(Date.now() - 3_600_000);
    expect(recent.length).toBe(1);
    expect(recent[0]?.suggestionTitle).toBe("Meeting with Anna");
  });

  test("checks cooldown correctly", () => {
    const { history } = createHistory();

    history.record({
      patternType: "meeting_prep",
      detectorId: "test",
      entityKey: "meeting:evt-1",
      confidence: 0.9,
      suggestionTitle: "Test",
      channelId: "telegram",
    });

    // Should be on cooldown
    expect(history.checkCooldown("meeting_prep", "meeting:evt-1", 240)).toBe(true);

    // Different entity key should not be on cooldown
    expect(history.checkCooldown("meeting_prep", "meeting:evt-2", 240)).toBe(false);

    // Different pattern type should not be on cooldown
    expect(history.checkCooldown("health_nudge", "meeting:evt-1", 240)).toBe(false);
  });

  test("records and queries feedback", () => {
    const { history } = createHistory();

    const record = history.record({
      patternType: "travel_prep",
      detectorId: "travel",
      entityKey: "travel:evt-1",
      confidence: 0.85,
      suggestionTitle: "Trip to Munich",
      channelId: "telegram",
    });

    history.recordFeedback(record.id, "helpful");

    const recent = history.getRecent(Date.now() - 3_600_000);
    expect(recent[0]?.feedback).toBe("helpful");
  });

  test("records acted_on timestamp", () => {
    const { history } = createHistory();

    const record = history.record({
      patternType: "follow_up",
      detectorId: "follow_up",
      entityKey: "followup:m1",
      confidence: 0.75,
      suggestionTitle: "Follow up reminder",
      channelId: "telegram",
    });

    history.recordActed(record.id);

    const recent = history.getRecent(Date.now() - 3_600_000);
    expect(recent[0]?.actedOnAt).toBeTruthy();
  });

  test("auto-suppresses after 3 annoying feedbacks", () => {
    const { history } = createHistory();

    // Create 3 suggestions with "annoying" feedback
    for (let i = 0; i < 3; i++) {
      const rec = history.record({
        patternType: "health_nudge",
        detectorId: "health",
        entityKey: `health:day-${i}`,
        confidence: 0.7,
        suggestionTitle: "Training reminder",
        channelId: "telegram",
      });
      history.recordFeedback(rec.id, "annoying");
    }

    // Should now be suppressed
    expect(history.isSuppressed("health_nudge", Date.now())).toBe(true);

    // Other pattern types should not be suppressed
    expect(history.isSuppressed("meeting_prep", Date.now())).toBe(false);
  });
});
