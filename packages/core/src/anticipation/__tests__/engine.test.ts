import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AnticipationConfigSchema, Ok } from "@eidolon/protocol";
import type { CalendarEvent, MemorySearchResult } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { EventBus } from "../../loop/event-bus.ts";
import { AnticipationEngine } from "../engine.ts";
import { SuggestionHistory } from "../history.ts";

const logger = createLogger({ level: "error", directory: "", format: "json", maxSizeMb: 10, maxFiles: 1 });

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      priority TEXT NOT NULL,
      payload TEXT NOT NULL,
      source TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      processed_at INTEGER,
      retry_count INTEGER NOT NULL DEFAULT 0,
      claimed_at INTEGER,
      retention_days INTEGER DEFAULT 30
    )
  `);
  return db;
}

function createMockMemorySearch(results: MemorySearchResult[] = []) {
  return {
    search: async () => Ok(results),
  };
}

function createMockProfileGenerator() {
  return {
    generateProfile: () => ({
      name: "Test User",
      timezone: "Europe/Berlin",
      languages: ["de"],
      preferences: [{ key: "daily training", value: "important", confidence: 0.9 }],
      interests: [],
      devices: [],
      recentTopics: [],
      skills: [],
      relationships: [],
      decisionPatterns: [],
      summary: "",
      generatedAt: Date.now(),
    }),
  };
}

function createMockCalendarManager(events: CalendarEvent[] = []) {
  return {
    getUpcoming: () => Ok(events),
    injectScheduleContext: () => Ok(""),
  };
}

describe("AnticipationEngine", () => {
  test("returns empty when disabled", async () => {
    const db = createTestDb();
    const eventBus = new EventBus(db, logger);
    const history = new SuggestionHistory(new Database(":memory:"), logger);
    const config = AnticipationConfigSchema.parse({ enabled: false });

    const engine = new AnticipationEngine({
      memorySearch: createMockMemorySearch() as never,
      calendarManager: null,
      profileGenerator: createMockProfileGenerator() as never,
      kgEntityStore: null,
      kgRelationStore: null,
      history,
      eventBus,
      config,
      logger,
    });

    const suggestions = await engine.check();
    expect(suggestions.length).toBe(0);
  });

  test("detects patterns and publishes suggestions", async () => {
    const now = Date.now();
    const db = createTestDb();
    const eventBus = new EventBus(db, logger);
    const historyDb = new Database(":memory:");
    const history = new SuggestionHistory(historyDb, logger);

    const meetingEvent: CalendarEvent = {
      id: "evt-1",
      calendarId: "cal-1",
      title: "Meeting with Anna",
      startTime: now + 30 * 60_000,
      endTime: now + 60 * 60_000,
      allDay: false,
      reminders: [],
      source: "manual",
      syncedAt: now,
    };

    const memResult: MemorySearchResult = {
      memory: {
        id: "m1",
        type: "episode",
        layer: "long_term",
        content: "Talked with Anna about project",
        confidence: 0.8,
        source: "chat",
        tags: [],
        createdAt: now - 86_400_000,
        updatedAt: now - 86_400_000,
        accessedAt: now - 86_400_000,
        accessCount: 1,
      },
      score: 0.9,
      matchReason: "bm25",
    };

    // Mock KG entity store with Anna
    const kgEntityStore = {
      findByName: (name: string) => {
        if (name === "Anna") return { ok: true, value: { name: "Anna Mueller" } };
        return { ok: true, value: null };
      },
      findByType: () => ({ ok: true, value: [] }),
      get: () => ({ ok: true, value: null }),
    };

    const config = AnticipationConfigSchema.parse({
      enabled: true,
      detectors: {
        meetingPrep: { enabled: true, windowMinutes: 60 },
        travelPrep: { enabled: false },
        healthNudge: { enabled: false },
        followUp: { enabled: false },
        birthday: { enabled: false },
      },
    });

    const engine = new AnticipationEngine({
      memorySearch: createMockMemorySearch([memResult]) as never,
      calendarManager: createMockCalendarManager([meetingEvent]) as never,
      profileGenerator: createMockProfileGenerator() as never,
      kgEntityStore: kgEntityStore as never,
      kgRelationStore: null,
      history,
      eventBus,
      config,
      logger,
    });

    const suggestions = await engine.check();
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]?.patternType).toBe("meeting_prep");
    expect(suggestions[0]?.title).toContain("Anna");
  });

  test("handles detector errors gracefully", async () => {
    const db = createTestDb();
    const eventBus = new EventBus(db, logger);
    const history = new SuggestionHistory(new Database(":memory:"), logger);

    const config = AnticipationConfigSchema.parse({
      enabled: true,
      detectors: {
        meetingPrep: { enabled: false },
        travelPrep: { enabled: false },
        healthNudge: { enabled: false },
        followUp: { enabled: false },
        birthday: { enabled: false },
      },
    });

    const engine = new AnticipationEngine({
      memorySearch: createMockMemorySearch() as never,
      calendarManager: null,
      profileGenerator: createMockProfileGenerator() as never,
      kgEntityStore: null,
      kgRelationStore: null,
      history,
      eventBus,
      config,
      logger,
    });

    // Register a failing detector
    engine.registerDetector({
      id: "failing",
      name: "Failing Detector",
      detect: async () => {
        throw new Error("boom");
      },
    });

    // Should not throw, just return empty
    const suggestions = await engine.check();
    expect(suggestions.length).toBe(0);
  });

  test("registers custom detectors", async () => {
    const db = createTestDb();
    const eventBus = new EventBus(db, logger);
    const history = new SuggestionHistory(new Database(":memory:"), logger);

    const config = AnticipationConfigSchema.parse({
      enabled: true,
      detectors: {
        meetingPrep: { enabled: false },
        travelPrep: { enabled: false },
        healthNudge: { enabled: false },
        followUp: { enabled: false },
        birthday: { enabled: false },
      },
    });

    const engine = new AnticipationEngine({
      memorySearch: createMockMemorySearch() as never,
      calendarManager: null,
      profileGenerator: createMockProfileGenerator() as never,
      kgEntityStore: null,
      kgRelationStore: null,
      history,
      eventBus,
      config,
      logger,
    });

    engine.registerDetector({
      id: "custom",
      name: "Custom Detector",
      detect: async () => [
        {
          detectorId: "custom",
          type: "routine_deviation" as const,
          confidence: 0.8,
          relevantEntities: [],
          metadata: {},
        },
      ],
    });

    const suggestions = await engine.check();
    expect(suggestions.length).toBe(1);
    expect(suggestions[0]?.patternType).toBe("routine_deviation");
  });

  test("returns empty with no patterns detected", async () => {
    const db = createTestDb();
    const eventBus = new EventBus(db, logger);
    const history = new SuggestionHistory(new Database(":memory:"), logger);

    const config = AnticipationConfigSchema.parse({
      enabled: true,
      detectors: {
        meetingPrep: { enabled: true },
        travelPrep: { enabled: false },
        healthNudge: { enabled: false },
        followUp: { enabled: false },
        birthday: { enabled: false },
      },
    });

    const engine = new AnticipationEngine({
      memorySearch: createMockMemorySearch() as never,
      calendarManager: createMockCalendarManager([]) as never,
      profileGenerator: createMockProfileGenerator() as never,
      kgEntityStore: null,
      kgRelationStore: null,
      history,
      eventBus,
      config,
      logger,
    });

    const suggestions = await engine.check();
    expect(suggestions.length).toBe(0);
  });
});
