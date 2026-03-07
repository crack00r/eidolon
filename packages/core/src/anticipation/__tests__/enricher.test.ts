import { describe, expect, test } from "bun:test";
import { Ok } from "@eidolon/protocol";
import type { MemorySearchResult } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { ContextEnricher } from "../enricher.ts";
import type { DetectedPattern } from "../patterns.ts";

const logger = createLogger({ level: "error", directory: "", format: "json", maxSizeMb: 10, maxFiles: 1 });

function makePattern(overrides: Partial<DetectedPattern> = {}): DetectedPattern {
  return {
    detectorId: "test",
    type: "meeting_prep",
    confidence: 0.9,
    relevantEntities: ["Anna"],
    metadata: {},
    ...overrides,
  };
}

function createMockMemorySearch(results: MemorySearchResult[] = []) {
  return {
    search: async () => Ok(results),
  };
}

function createMockCalendarManager(context: string = "") {
  return {
    injectScheduleContext: () => Ok(context),
  };
}

describe("ContextEnricher", () => {
  test("queries memories for meeting_prep patterns", async () => {
    const memResult: MemorySearchResult = {
      memory: {
        id: "m1",
        type: "episode",
        layer: "long_term",
        content: "Discussed project with Anna",
        confidence: 0.8,
        source: "chat",
        tags: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 1,
      },
      score: 0.9,
      matchReason: "bm25",
    };

    const enricher = new ContextEnricher(
      createMockMemorySearch([memResult]) as never,
      createMockCalendarManager("Meeting at 14:00") as never,
      logger,
    );

    const pattern = makePattern({ relevantEntities: ["Anna"] });
    const enriched = await enricher.enrich(pattern);

    expect(enriched.relatedMemories.length).toBe(1);
    expect(enriched.calendarContext).toBe("Meeting at 14:00");
  });

  test("handles empty memory results gracefully", async () => {
    const enricher = new ContextEnricher(
      createMockMemorySearch([]) as never,
      null,
      logger,
    );

    const pattern = makePattern({ type: "health_nudge", relevantEntities: [] });
    const enriched = await enricher.enrich(pattern);

    expect(enriched.relatedMemories.length).toBe(0);
    expect(enriched.calendarContext).toBe("");
  });

  test("enriches multiple patterns", async () => {
    const enricher = new ContextEnricher(
      createMockMemorySearch([]) as never,
      null,
      logger,
    );

    const patterns = [
      makePattern({ type: "meeting_prep" }),
      makePattern({ type: "follow_up", metadata: { commitment: "send report" } }),
    ];

    const results = await enricher.enrichAll(patterns);
    expect(results.length).toBe(2);
  });

  test("includes calendar context only for calendar-related patterns", async () => {
    const enricher = new ContextEnricher(
      createMockMemorySearch([]) as never,
      createMockCalendarManager("14:00 Team Meeting") as never,
      logger,
    );

    const followUp = makePattern({ type: "follow_up", metadata: { commitment: "send docs" } });
    const meeting = makePattern({ type: "meeting_prep" });

    const followUpCtx = await enricher.enrich(followUp);
    const meetingCtx = await enricher.enrich(meeting);

    expect(followUpCtx.calendarContext).toBe("");
    expect(meetingCtx.calendarContext).toBe("14:00 Team Meeting");
  });
});
