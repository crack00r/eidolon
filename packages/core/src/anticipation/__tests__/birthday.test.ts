import { describe, expect, test } from "bun:test";
import type { KGEntity, KGRelation } from "@eidolon/protocol";
import { BirthdayDetector } from "../detectors/birthday.ts";
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

// Mock stores
function createStores(persons: KGEntity[], relations: KGRelation[], dateEntities: Record<string, KGEntity>) {
  return {
    entityStore: {
      findByType: (_type: string, _limit?: number) => ({ ok: true, value: persons }),
      get: (id: string) => {
        const entity = dateEntities[id];
        return entity ? { ok: true, value: entity } : { ok: true, value: null };
      },
    },
    relationStore: {
      findBySubject: (entityId: string) => ({
        ok: true,
        value: relations.filter((r) => r.sourceId === entityId),
      }),
    },
  };
}

describe("BirthdayDetector", () => {
  test("detects upcoming birthday from KG relations", async () => {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const month = String(tomorrow.getMonth() + 1).padStart(2, "0");
    const day = String(tomorrow.getDate()).padStart(2, "0");
    const birthdayDate = `1990-${month}-${day}`;

    const person: KGEntity = {
      id: "person-1",
      name: "Maria Schmidt",
      type: "person",
      attributes: {},
      createdAt: Date.now(),
    };

    const dateEntity: KGEntity = {
      id: "date-1",
      name: birthdayDate,
      type: "concept",
      attributes: { date: birthdayDate },
      createdAt: Date.now(),
    };

    const relation: KGRelation = {
      id: "rel-1",
      sourceId: "person-1",
      targetId: "date-1",
      type: "birthday",
      confidence: 1.0,
      source: "user",
      createdAt: Date.now(),
    };

    const { entityStore, relationStore } = createStores([person], [relation], { "date-1": dateEntity });

    const detector = new BirthdayDetector(entityStore as never, relationStore as never, {
      enabled: true,
      daysBefore: 1,
    });

    const ctx = makeContext({ now: now.getTime() });
    const patterns = await detector.detect(ctx);

    expect(patterns.length).toBe(1);
    expect(patterns[0]?.type).toBe("birthday_reminder");
    expect(patterns[0]?.confidence).toBe(0.95);
    expect(patterns[0]?.relevantEntities).toContain("Maria Schmidt");
  });

  test("does not fire for birthdays far in the future", async () => {
    const now = new Date();
    // Set birthday 30 days from now
    const future = new Date(now);
    future.setDate(future.getDate() + 30);
    const month = String(future.getMonth() + 1).padStart(2, "0");
    const day = String(future.getDate()).padStart(2, "0");

    const person: KGEntity = {
      id: "p-1",
      name: "Hans",
      type: "person",
      attributes: {},
      createdAt: Date.now(),
    };

    const dateEntity: KGEntity = {
      id: "d-1",
      name: `1985-${month}-${day}`,
      type: "concept",
      attributes: { date: `1985-${month}-${day}` },
      createdAt: Date.now(),
    };

    const rel: KGRelation = {
      id: "r-1",
      sourceId: "p-1",
      targetId: "d-1",
      type: "birthday",
      confidence: 1,
      source: "user",
      createdAt: Date.now(),
    };

    const { entityStore, relationStore } = createStores([person], [rel], { "d-1": dateEntity });
    const detector = new BirthdayDetector(entityStore as never, relationStore as never, {
      enabled: true,
      daysBefore: 3,
    });

    const ctx = makeContext({ now: now.getTime() });
    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });

  test("returns empty when KG stores are null", async () => {
    const detector = new BirthdayDetector(null, null, { enabled: true, daysBefore: 1 });
    const ctx = makeContext();
    const patterns = await detector.detect(ctx);
    expect(patterns.length).toBe(0);
  });
});
