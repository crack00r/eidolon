import { describe, expect, test } from "bun:test";
import type { CalendarEvent } from "@eidolon/protocol";
import { TravelPrepDetector } from "../detectors/travel-prep.ts";
import type { DetectionContext } from "../patterns.ts";

function makeContext(overrides: Partial<DetectionContext> = {}): DetectionContext {
  return {
    now: Date.now(),
    profile: {
      name: "Test",
      timezone: undefined,
      languages: [],
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
    title: "Event",
    startTime: now + 12 * 3_600_000,
    endTime: now + 14 * 3_600_000,
    allDay: false,
    reminders: [],
    source: "manual",
    syncedAt: now,
    ...overrides,
  };
}

describe("TravelPrepDetector", () => {
  test("detects travel by explicit location", async () => {
    const now = Date.now();
    const event = makeEvent({ location: "Munich", startTime: now + 12 * 3_600_000 });
    const detector = new TravelPrepDetector({ enabled: true, windowHours: 24, homeCity: "Berlin" });
    const ctx = makeContext({ now, upcomingEvents: [event] });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(1);
    expect(patterns[0]?.type).toBe("travel_prep");
    expect(patterns[0]?.confidence).toBe(0.85);
  });

  test("handles missing location with travel keywords", async () => {
    const now = Date.now();
    const event = makeEvent({ title: "Flight to Hamburg", startTime: now + 6 * 3_600_000 });
    const detector = new TravelPrepDetector({ enabled: true, windowHours: 24, homeCity: "" });
    const ctx = makeContext({ now, upcomingEvents: [event] });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(1);
    expect(patterns[0]?.confidence).toBe(0.5);
  });

  test("excludes home city from travel detection", async () => {
    const now = Date.now();
    const event = makeEvent({ location: "Berlin Office", startTime: now + 6 * 3_600_000 });
    const detector = new TravelPrepDetector({ enabled: true, windowHours: 24, homeCity: "Berlin" });
    const ctx = makeContext({ now, upcomingEvents: [event] });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });

  test("skips events outside the window", async () => {
    const now = Date.now();
    const event = makeEvent({ location: "Munich", startTime: now + 48 * 3_600_000 });
    const detector = new TravelPrepDetector({ enabled: true, windowHours: 24, homeCity: "" });
    const ctx = makeContext({ now, upcomingEvents: [event] });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });
});
