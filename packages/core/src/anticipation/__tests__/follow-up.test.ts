import { describe, expect, test } from "bun:test";
import type { Memory } from "@eidolon/protocol";
import { FollowUpDetector } from "../detectors/follow-up.ts";
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

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    type: "decision",
    layer: "long_term",
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

describe("FollowUpDetector", () => {
  test("detects unresolved commitments after delay", async () => {
    const now = Date.now();
    const commitment = makeMemory({
      id: "mem-commit",
      content: "I will send the report to the team tomorrow",
      createdAt: now - 72 * 3_600_000, // 72 hours ago
    });

    const detector = new FollowUpDetector({ enabled: true, delayHours: 48 });
    const ctx = makeContext({ now, recentMemories: [commitment] });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(1);
    expect(patterns[0]?.type).toBe("follow_up");
    expect(patterns[0]?.confidence).toBe(0.75);
  });

  test("respects delay window (too recent)", async () => {
    const now = Date.now();
    const commitment = makeMemory({
      content: "I'll send the article later",
      createdAt: now - 12 * 3_600_000, // only 12 hours ago
    });

    const detector = new FollowUpDetector({ enabled: true, delayHours: 48 });
    const ctx = makeContext({ now, recentMemories: [commitment] });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });

  test("ignores resolved commitments", async () => {
    const now = Date.now();
    const commitment = makeMemory({
      id: "mem-1",
      content: "I will send the report to the team",
      createdAt: now - 72 * 3_600_000,
    });
    const resolution = makeMemory({
      id: "mem-2",
      content: "Sent the report to the team as promised",
      createdAt: now - 24 * 3_600_000,
    });

    const detector = new FollowUpDetector({ enabled: true, delayHours: 48 });
    const ctx = makeContext({ now, recentMemories: [commitment, resolution] });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });

  test("only checks decision and episode memories", async () => {
    const now = Date.now();
    const preference = makeMemory({
      type: "preference",
      content: "I will always prefer dark mode",
      createdAt: now - 72 * 3_600_000,
    });

    const detector = new FollowUpDetector({ enabled: true, delayHours: 48 });
    const ctx = makeContext({ now, recentMemories: [preference] });

    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });
});
