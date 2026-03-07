import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Ok } from "@eidolon/protocol";
import type { CalendarEvent, Memory, MemorySearchResult } from "@eidolon/protocol";
import { createLogger } from "../../logging/logger.ts";
import { MeetingPrepDetector } from "../detectors/meeting-prep.ts";
import type { DetectionContext } from "../patterns.ts";

const logger = createLogger({ level: "error", directory: "", format: "json", maxSizeMb: 10, maxFiles: 1 });

function makeContext(overrides: Partial<DetectionContext> = {}): DetectionContext {
  return {
    now: Date.now(),
    profile: {
      name: "Test User",
      timezone: "Europe/Berlin",
      languages: ["de", "en"],
      preferences: [],
      interests: [],
      devices: [],
      recentTopics: [],
      skills: [],
      relationships: [],
      decisionPatterns: [],
      summary: "",
      generatedAt: Date.now(),
    },
    upcomingEvents: [],
    recentMemories: [],
    timezone: "Europe/Berlin",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  const now = Date.now();
  return {
    id: "evt-1",
    calendarId: "cal-1",
    title: "Meeting with Anna",
    startTime: now + 30 * 60_000,
    endTime: now + 60 * 60_000,
    allDay: false,
    reminders: [15],
    source: "manual",
    syncedAt: now,
    ...overrides,
  };
}

// Minimal mock for MemorySearch
function createMockMemorySearch(results: MemorySearchResult[] = []) {
  return {
    search: async () => Ok(results),
  };
}

// Minimal mock for KGEntityStore
function createMockKGEntityStore(entities: Record<string, { name: string }> = {}): {
  findByName: (name: string) => { ok: boolean; value: { name: string } | null };
} {
  return {
    findByName: (name: string) => {
      const lower = name.toLowerCase();
      for (const [key, val] of Object.entries(entities)) {
        if (key.toLowerCase() === lower) return { ok: true, value: val };
      }
      return { ok: true, value: null };
    },
  };
}

describe("MeetingPrepDetector", () => {
  test("detects upcoming meetings with known attendees in KG", async () => {
    const now = Date.now();
    const event = makeEvent({ title: "Meeting with Anna", startTime: now + 30 * 60_000 });
    const kgStore = createMockKGEntityStore({ Anna: { name: "Anna Mueller" } });
    const memSearch = createMockMemorySearch();

    const detector = new MeetingPrepDetector(
      memSearch as never,
      kgStore as never,
      { enabled: true, windowMinutes: 60 },
    );

    const context = makeContext({ now, upcomingEvents: [event] });
    const patterns = await detector.detect(context);

    expect(patterns.length).toBe(1);
    expect(patterns[0]?.type).toBe("meeting_prep");
    expect(patterns[0]?.confidence).toBe(0.9);
    expect(patterns[0]?.relevantEntities).toContain("Anna Mueller");
  });

  test("skips all-day events", async () => {
    const now = Date.now();
    const event = makeEvent({ allDay: true, startTime: now + 30 * 60_000 });

    const detector = new MeetingPrepDetector(
      createMockMemorySearch() as never,
      createMockKGEntityStore() as never,
      { enabled: true, windowMinutes: 60 },
    );

    const context = makeContext({ now, upcomingEvents: [event] });
    const patterns = await detector.detect(context);
    expect(patterns.length).toBe(0);
  });

  test("skips events outside the window", async () => {
    const now = Date.now();
    const event = makeEvent({ startTime: now + 120 * 60_000 }); // 2 hours out

    const detector = new MeetingPrepDetector(
      createMockMemorySearch() as never,
      createMockKGEntityStore() as never,
      { enabled: true, windowMinutes: 60 },
    );

    const context = makeContext({ now, upcomingEvents: [event] });
    const patterns = await detector.detect(context);
    expect(patterns.length).toBe(0);
  });

  test("falls back to memory search when KG has no match", async () => {
    const now = Date.now();
    const event = makeEvent({ title: "Call with Bob", startTime: now + 20 * 60_000 });

    const memResult: MemorySearchResult = {
      memory: {
        id: "mem-1",
        type: "episode",
        layer: "long_term",
        content: "Talked to Bob about the project",
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

    const detector = new MeetingPrepDetector(
      createMockMemorySearch([memResult]) as never,
      createMockKGEntityStore() as never,
      { enabled: true, windowMinutes: 60 },
    );

    const context = makeContext({ now, upcomingEvents: [event] });
    const patterns = await detector.detect(context);

    expect(patterns.length).toBe(1);
    expect(patterns[0]?.confidence).toBe(0.6);
  });

  test("skips events with no attendee names", async () => {
    const now = Date.now();
    const event = makeEvent({ title: "lunch break", startTime: now + 30 * 60_000 });

    const detector = new MeetingPrepDetector(
      createMockMemorySearch() as never,
      createMockKGEntityStore() as never,
      { enabled: true, windowMinutes: 60 },
    );

    const context = makeContext({ now, upcomingEvents: [event] });
    const patterns = await detector.detect(context);
    expect(patterns.length).toBe(0);
  });
});
