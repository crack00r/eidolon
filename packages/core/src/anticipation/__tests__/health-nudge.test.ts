import { describe, expect, test } from "bun:test";
import type { Memory } from "@eidolon/protocol";
import { HealthNudgeDetector } from "../detectors/health-nudge.ts";
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
    timezone: "UTC",
    ...overrides,
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    type: "episode",
    layer: "short_term",
    content: "",
    confidence: 0.8,
    source: "chat",
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    accessedAt: Date.now(),
    accessCount: 1,
    ...overrides,
  };
}

const DEFAULT_CONFIG = { enabled: true, afterHour: 17, activityTags: ["training", "exercise", "workout", "gym"] };

describe("HealthNudgeDetector", () => {
  test("fires after threshold hour when no activity found", async () => {
    // Set time to 18:00 UTC
    const now = new Date();
    now.setUTCHours(18, 0, 0, 0);

    const detector = new HealthNudgeDetector(DEFAULT_CONFIG);
    const ctx = makeContext({
      now: now.getTime(),
      profile: {
        name: "Test",
        timezone: undefined,
        languages: [],
        preferences: [{ key: "daily training", value: "important", confidence: 0.9 }],
        interests: [],
        devices: [],
        recentTopics: [],
        skills: [],
        relationships: [],
        decisionPatterns: [],
        summary: "",
        generatedAt: now.getTime(),
      },
    });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(1);
    expect(patterns[0]?.type).toBe("health_nudge");
    expect(patterns[0]?.confidence).toBe(0.7);
  });

  test("skips if activity found today", async () => {
    const now = new Date();
    now.setUTCHours(18, 0, 0, 0);

    const todayActivity = makeMemory({
      content: "went to the gym for training",
      createdAt: now.getTime() - 3_600_000, // 1 hour ago
      tags: ["training"],
    });

    const detector = new HealthNudgeDetector(DEFAULT_CONFIG);
    const ctx = makeContext({
      now: now.getTime(),
      profile: {
        name: "Test",
        timezone: undefined,
        languages: [],
        preferences: [{ key: "exercise routine", value: "daily", confidence: 0.9 }],
        interests: [],
        devices: [],
        recentTopics: [],
        skills: [],
        relationships: [],
        decisionPatterns: [],
        summary: "",
        generatedAt: now.getTime(),
      },
      recentMemories: [todayActivity],
    });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });

  test("skips before threshold hour", async () => {
    const now = new Date();
    now.setUTCHours(14, 0, 0, 0);

    const detector = new HealthNudgeDetector(DEFAULT_CONFIG);
    const ctx = makeContext({
      now: now.getTime(),
      profile: {
        name: "Test",
        timezone: undefined,
        languages: [],
        preferences: [{ key: "training", value: "daily", confidence: 0.9 }],
        interests: [],
        devices: [],
        recentTopics: [],
        skills: [],
        relationships: [],
        decisionPatterns: [],
        summary: "",
        generatedAt: now.getTime(),
      },
    });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });

  test("skips if user has no exercise preferences", async () => {
    const now = new Date();
    now.setUTCHours(18, 0, 0, 0);

    const detector = new HealthNudgeDetector(DEFAULT_CONFIG);
    const ctx = makeContext({ now: now.getTime() });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });
});
