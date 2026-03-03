import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import type { UserProfile } from "../profile.ts";
import { formatProfileMarkdown, UserProfileGenerator } from "../profile.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const result = runMigrations(db, "memory", MEMORY_MIGRATIONS, createSilentLogger());
  if (!result.ok) {
    throw new Error(`Migration failed: ${result.error.message}`);
  }
  return db;
}

function insertMemory(
  db: Database,
  overrides: {
    type?: string;
    layer?: string;
    content?: string;
    confidence?: number;
    source?: string;
    tags?: string;
    created_at?: number;
    updated_at?: number;
  } = {},
): void {
  const id = crypto.randomUUID();
  const now = Date.now();
  db.query(
    `INSERT INTO memories (id, type, layer, content, confidence, source, tags, created_at, updated_at, accessed_at, access_count, metadata, sensitive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '{}', 0)`,
  ).run(
    id,
    overrides.type ?? "fact",
    overrides.layer ?? "long_term",
    overrides.content ?? "test content",
    overrides.confidence ?? 0.9,
    overrides.source ?? "test",
    overrides.tags ?? "[]",
    overrides.created_at ?? now,
    overrides.updated_at ?? now,
    now,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UserProfileGenerator", () => {
  let db: Database;
  let generator: UserProfileGenerator;

  beforeEach(() => {
    db = createTestDb();
    generator = new UserProfileGenerator(db, createSilentLogger(), "Manuel");
  });

  afterEach(() => {
    db.close();
  });

  // -- Empty database -------------------------------------------------------

  test("generateProfile() returns correct structure with empty database", () => {
    const profile = generator.generateProfile();

    expect(profile.name).toBe("Manuel");
    expect(profile.preferences).toEqual([]);
    expect(profile.interests).toEqual([]);
    expect(profile.recentTopics).toEqual([]);
    expect(profile.skills).toEqual([]);
    expect(profile.decisionPatterns).toEqual([]);
    expect(profile.generatedAt).toBeGreaterThan(0);
    expect(profile.summary).toContain("Manuel");
    expect(profile.summary).toContain("still being built");
  });

  // -- Preferences ----------------------------------------------------------

  test("generateProfile() extracts preferences from preference-type memories", () => {
    insertMemory(db, {
      type: "preference",
      content: "Prefers dark mode for all applications",
      confidence: 0.95,
    });
    insertMemory(db, {
      type: "preference",
      content: "Likes TypeScript over JavaScript",
      confidence: 0.85,
    });
    // Non-preference memory should not appear
    insertMemory(db, {
      type: "fact",
      content: "The sky is blue",
      confidence: 0.99,
    });

    const profile = generator.generateProfile();

    expect(profile.preferences).toHaveLength(2);
    expect(profile.preferences[0]?.confidence).toBe(0.95);
    expect(profile.preferences[0]?.value).toContain("dark mode");
    expect(profile.preferences[1]?.confidence).toBe(0.85);
  });

  test("generateProfile() orders preferences by confidence DESC", () => {
    insertMemory(db, { type: "preference", content: "Low confidence pref", confidence: 0.5 });
    insertMemory(db, { type: "preference", content: "High confidence pref", confidence: 0.99 });
    insertMemory(db, { type: "preference", content: "Medium confidence pref", confidence: 0.75 });

    const profile = generator.generateProfile();

    expect(profile.preferences[0]?.confidence).toBe(0.99);
    expect(profile.preferences[1]?.confidence).toBe(0.75);
    expect(profile.preferences[2]?.confidence).toBe(0.5);
  });

  // -- Interests ------------------------------------------------------------

  test("generateProfile() counts interests from tags", () => {
    insertMemory(db, { tags: '["typescript","programming"]' });
    insertMemory(db, { tags: '["typescript","bun"]' });
    insertMemory(db, { tags: '["typescript"]' });
    insertMemory(db, { tags: '["rust"]' });

    const profile = generator.generateProfile();

    expect(profile.interests.length).toBeGreaterThanOrEqual(3);
    // TypeScript should be the top interest with 3 mentions
    expect(profile.interests[0]?.topic).toBe("typescript");
    expect(profile.interests[0]?.mentionCount).toBe(3);
  });

  test("generateProfile() normalizes tag casing for interests", () => {
    insertMemory(db, { tags: '["TypeScript"]' });
    insertMemory(db, { tags: '["typescript"]' });
    insertMemory(db, { tags: '["TYPESCRIPT"]' });

    const profile = generator.generateProfile();

    // All should be counted as a single interest
    const tsInterest = profile.interests.find((i) => i.topic === "typescript");
    expect(tsInterest).toBeDefined();
    expect(tsInterest?.mentionCount).toBe(3);
  });

  // -- Recent topics --------------------------------------------------------

  test("generateProfile() gets recent topics from last 7 days", () => {
    const now = Date.now();
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

    insertMemory(db, { tags: '["recent-topic"]', created_at: now });
    insertMemory(db, { tags: '["somewhat-recent"]', created_at: threeDaysAgo });
    insertMemory(db, { tags: '["old-topic"]', created_at: tenDaysAgo });

    const profile = generator.generateProfile();

    const recentTopicNames = profile.recentTopics.map((t) => t.topic);
    expect(recentTopicNames).toContain("recent-topic");
    expect(recentTopicNames).toContain("somewhat-recent");
    expect(recentTopicNames).not.toContain("old-topic");
  });

  test("generateProfile() orders recent topics by most recent first", () => {
    const now = Date.now();
    const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

    insertMemory(db, { tags: '["older-topic"]', created_at: twoDaysAgo });
    insertMemory(db, { tags: '["newer-topic"]', created_at: now });

    const profile = generator.generateProfile();

    expect(profile.recentTopics[0]?.topic).toBe("newer-topic");
    expect(profile.recentTopics[1]?.topic).toBe("older-topic");
  });

  // -- Skills ---------------------------------------------------------------

  test("generateProfile() extracts skills from skill-type memories", () => {
    insertMemory(db, {
      type: "skill",
      content: "Expert at TypeScript development",
      confidence: 0.9,
    });
    insertMemory(db, {
      type: "skill",
      content: "Learning Rust programming",
      confidence: 0.7,
    });

    const profile = generator.generateProfile();

    expect(profile.skills).toHaveLength(2);
    expect(profile.skills[0]?.name).toContain("TypeScript");
    expect(profile.skills[0]?.level).toBe("advanced");
    expect(profile.skills[1]?.name).toContain("Rust");
    expect(profile.skills[1]?.level).toBe("beginner");
  });

  test("generateProfile() infers unknown level when no keyword matches", () => {
    insertMemory(db, {
      type: "skill",
      content: "Can write SQL queries",
      confidence: 0.8,
    });

    const profile = generator.generateProfile();

    expect(profile.skills).toHaveLength(1);
    expect(profile.skills[0]?.level).toBe("unknown");
  });

  // -- Decision patterns ----------------------------------------------------

  test("generateProfile() groups similar decisions and counts examples", () => {
    insertMemory(db, {
      type: "decision",
      content: "Chose TypeScript over Python for the core daemon",
      confidence: 0.95,
    });
    insertMemory(db, {
      type: "decision",
      content: "Decided to use Bun as the runtime",
      confidence: 0.9,
    });

    const profile = generator.generateProfile();

    expect(profile.decisionPatterns.length).toBeGreaterThanOrEqual(2);
    expect(profile.decisionPatterns[0]?.examples).toBeGreaterThanOrEqual(1);
  });

  // -- Summary --------------------------------------------------------------

  test("buildSummary includes top interests and preferences", () => {
    insertMemory(db, {
      type: "preference",
      content: "Prefers dark mode",
      confidence: 0.95,
    });
    insertMemory(db, {
      tags: '["typescript"]',
    });
    insertMemory(db, {
      tags: '["typescript"]',
    });

    const profile = generator.generateProfile();

    expect(profile.summary).toContain("Manuel");
    expect(profile.summary).toContain("typescript");
    expect(profile.summary).toContain("Prefers dark mode");
  });

  test("buildSummary handles case with only interests", () => {
    insertMemory(db, { tags: '["ai"]' });
    insertMemory(db, { tags: '["ai"]' });

    const profile = generator.generateProfile();

    expect(profile.summary).toContain("interested in ai");
  });

  // -- Tags edge cases ------------------------------------------------------

  test("handles memories with empty tags gracefully", () => {
    insertMemory(db, { tags: "[]" });
    insertMemory(db, { tags: "" }); // invalid JSON
    insertMemory(db, { tags: "null" }); // null JSON

    const profile = generator.generateProfile();

    // Should not crash, interests should be empty
    expect(profile.interests).toEqual([]);
  });

  test("handles memories with non-string tags gracefully", () => {
    insertMemory(db, { tags: "[1, 2, 3]" }); // numbers, not strings
    insertMemory(db, { tags: '[null, "valid"]' }); // mixed types

    const profile = generator.generateProfile();

    // Only "valid" should be counted
    const validInterest = profile.interests.find((i) => i.topic === "valid");
    expect(validInterest?.mentionCount).toBe(1);
  });

  // -- getProfileSection (markdown) -----------------------------------------

  test("getProfileSection() returns valid markdown", () => {
    insertMemory(db, {
      type: "preference",
      content: "Prefers TypeScript",
      confidence: 0.9,
    });
    insertMemory(db, {
      type: "skill",
      content: "Expert at database design",
      confidence: 0.85,
    });
    insertMemory(db, {
      tags: '["sqlite","databases"]',
    });

    const md = generator.getProfileSection();

    expect(md).toContain("## User Profile");
    expect(md).toContain("**Name:** Manuel");
    expect(md).toContain("### Preferences");
    expect(md).toContain("### Skills");
    expect(md).toContain("### Interests");
    expect(md).toContain("### Summary");
  });

  test("getProfileSection() returns minimal markdown for empty database", () => {
    const md = generator.getProfileSection();

    expect(md).toContain("## User Profile");
    expect(md).toContain("**Name:** Manuel");
    expect(md).toContain("### Summary");
    expect(md).toContain("still being built");
  });
});

// ---------------------------------------------------------------------------
// formatProfileMarkdown standalone tests
// ---------------------------------------------------------------------------

describe("formatProfileMarkdown", () => {
  test("formats a full profile correctly", () => {
    const profile: UserProfile = {
      name: "Test User",
      preferences: [{ key: "Dark mode", value: "Prefers dark mode", confidence: 0.95 }],
      interests: [{ topic: "typescript", mentionCount: 5 }],
      recentTopics: [{ topic: "sqlite", lastMentioned: Date.now() }],
      skills: [{ name: "TypeScript", level: "advanced" }],
      decisionPatterns: [{ pattern: "Chose TypeScript", examples: 3 }],
      summary: "Test User is interested in typescript.",
      generatedAt: Date.now(),
    };

    const md = formatProfileMarkdown(profile);

    expect(md).toContain("## User Profile");
    expect(md).toContain("**Name:** Test User");
    expect(md).toContain("### Preferences");
    expect(md).toContain("Dark mode (confidence: 0.95)");
    expect(md).toContain("### Interests");
    expect(md).toContain("typescript (mentioned 5 times)");
    expect(md).toContain("### Recent Topics");
    expect(md).toContain("sqlite");
    expect(md).toContain("### Skills");
    expect(md).toContain("TypeScript (advanced)");
    expect(md).toContain("### Decision Patterns");
    expect(md).toContain("Chose TypeScript (3 examples)");
    expect(md).toContain("### Summary");
  });

  test("formats profile with empty sections correctly", () => {
    const profile: UserProfile = {
      name: "Empty User",
      preferences: [],
      interests: [],
      recentTopics: [],
      skills: [],
      decisionPatterns: [],
      summary: "Profile still being built.",
      generatedAt: Date.now(),
    };

    const md = formatProfileMarkdown(profile);

    expect(md).toContain("## User Profile");
    expect(md).toContain("**Name:** Empty User");
    expect(md).not.toContain("### Preferences");
    expect(md).not.toContain("### Interests");
    expect(md).toContain("### Summary");
    expect(md).toContain("Profile still being built.");
  });

  test("formats singular example count correctly", () => {
    const profile: UserProfile = {
      name: "User",
      preferences: [],
      interests: [],
      recentTopics: [],
      skills: [],
      decisionPatterns: [{ pattern: "Single decision", examples: 1 }],
      summary: "Summary.",
      generatedAt: Date.now(),
    };

    const md = formatProfileMarkdown(profile);
    expect(md).toContain("Single decision (1 example)");
    expect(md).not.toContain("1 examples");
  });
});
