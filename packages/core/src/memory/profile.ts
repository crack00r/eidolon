/**
 * UserProfileGenerator -- builds a structured user profile from accumulated
 * memories in the database.
 *
 * Purely template/query-based: NO LLM calls are made. The profile is built
 * from SQL queries over the `memories` table, extracting preferences, interests,
 * recent topics, skills, and decision patterns.
 *
 * Inspired by Mem0's `get_profile()` API.
 */

import type { Database } from "bun:sqlite";
import type { Logger } from "../logging/logger.ts";
import { formatProfileMarkdown } from "./profile-formatter.ts";

// Re-export so consumers can import from a single location
export { formatProfileMarkdown } from "./profile-formatter.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfilePreference {
  readonly key: string;
  readonly value: string;
  readonly confidence: number;
}

export interface ProfileInterest {
  readonly topic: string;
  readonly mentionCount: number;
}

export interface ProfileRecentTopic {
  readonly topic: string;
  readonly lastMentioned: number;
}

export interface ProfileSkill {
  readonly name: string;
  readonly level: string;
}

export interface ProfileDecisionPattern {
  readonly pattern: string;
  readonly examples: number;
}

export interface UserProfile {
  readonly name: string;
  readonly preferences: ReadonlyArray<ProfilePreference>;
  readonly interests: ReadonlyArray<ProfileInterest>;
  readonly recentTopics: ReadonlyArray<ProfileRecentTopic>;
  readonly skills: ReadonlyArray<ProfileSkill>;
  readonly decisionPatterns: ReadonlyArray<ProfileDecisionPattern>;
  readonly summary: string;
  readonly generatedAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_PREFERENCES = 20;
const MAX_INTERESTS = 15;
const MAX_RECENT_TOPICS = 10;
const MAX_SKILLS = 15;
const MAX_DECISION_PATTERNS = 10;
const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Row shapes from SQLite
// ---------------------------------------------------------------------------

interface ContentConfidenceRow {
  readonly content: string;
  readonly confidence: number;
}

interface TagsRow {
  readonly tags: string;
}

interface TagsTimestampRow {
  readonly tags: string;
  readonly created_at: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely parse a JSON tags string into a string array.
 * Returns an empty array if parsing fails or the result is not an array.
 */
function parseTags(tagsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(tagsJson);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === "string");
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Infer a skill level from the memory content using simple heuristics.
 * Looks for keywords indicating proficiency.
 */
function inferSkillLevel(content: string): string {
  const lower = content.toLowerCase();
  if (lower.includes("expert") || lower.includes("advanced") || lower.includes("mastered")) {
    return "advanced";
  }
  if (lower.includes("intermediate") || lower.includes("familiar") || lower.includes("comfortable")) {
    return "intermediate";
  }
  if (lower.includes("beginner") || lower.includes("learning") || lower.includes("started")) {
    return "beginner";
  }
  return "unknown";
}

/**
 * Extract a short name from skill memory content.
 * Takes the first sentence or up to 80 characters, whichever is shorter.
 */
function extractSkillName(content: string): string {
  const firstSentence = content.split(/[.!?]/)[0]?.trim() ?? content.trim();
  if (firstSentence.length <= 80) {
    return firstSentence;
  }
  return `${firstSentence.slice(0, 77)}...`;
}

/**
 * Extract a short pattern description from decision content.
 * Takes the first sentence or up to 100 characters.
 */
function extractPattern(content: string): string {
  const firstSentence = content.split(/[.!?]/)[0]?.trim() ?? content.trim();
  if (firstSentence.length <= 100) {
    return firstSentence;
  }
  return `${firstSentence.slice(0, 97)}...`;
}

// ---------------------------------------------------------------------------
// UserProfileGenerator
// ---------------------------------------------------------------------------

export class UserProfileGenerator {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly ownerName: string;

  constructor(db: Database, logger: Logger, ownerName: string) {
    this.db = db;
    this.logger = logger.child("profile");
    this.ownerName = ownerName;
  }

  /** Generate a complete user profile from accumulated memories. */
  generateProfile(): UserProfile {
    const preferences = this.getPreferences();
    const interests = this.getInterests();
    const recentTopics = this.getRecentTopics();
    const skills = this.getSkills();
    const decisionPatterns = this.getDecisionPatterns();
    const summary = this.buildSummary(preferences, interests, recentTopics);

    this.logger.debug("generateProfile", "Profile generated", {
      preferences: preferences.length,
      interests: interests.length,
      recentTopics: recentTopics.length,
      skills: skills.length,
      decisionPatterns: decisionPatterns.length,
    });

    return {
      name: this.ownerName,
      preferences,
      interests,
      recentTopics,
      skills,
      decisionPatterns,
      summary,
      generatedAt: Date.now(),
    };
  }

  /** Generate a markdown section suitable for MEMORY.md injection. */
  getProfileSection(): string {
    const profile = this.generateProfile();
    return formatProfileMarkdown(profile);
  }

  // -----------------------------------------------------------------------
  // Private query methods
  // -----------------------------------------------------------------------

  private getPreferences(): ReadonlyArray<ProfilePreference> {
    try {
      const rows = this.db
        .query(
          `SELECT content, confidence
           FROM memories
           WHERE type = 'preference'
           ORDER BY confidence DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(MAX_PREFERENCES) as ContentConfidenceRow[];

      return rows.map((row) => ({
        key: extractPattern(row.content),
        value: row.content,
        confidence: row.confidence,
      }));
    } catch (err) {
      this.logger.error("getPreferences", "Failed to query preferences", err);
      return [];
    }
  }

  private getInterests(): ReadonlyArray<ProfileInterest> {
    try {
      const rows = this.db.query("SELECT tags FROM memories WHERE tags != '[]'").all() as TagsRow[];

      const tagCounts = new Map<string, number>();
      for (const row of rows) {
        const tags = parseTags(row.tags);
        for (const tag of tags) {
          const normalized = tag.toLowerCase().trim();
          if (normalized.length === 0) continue;
          tagCounts.set(normalized, (tagCounts.get(normalized) ?? 0) + 1);
        }
      }

      const sorted = [...tagCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_INTERESTS);

      return sorted.map(([topic, mentionCount]) => ({ topic, mentionCount }));
    } catch (err) {
      this.logger.error("getInterests", "Failed to query interests", err);
      return [];
    }
  }

  private getRecentTopics(): ReadonlyArray<ProfileRecentTopic> {
    try {
      const cutoff = Date.now() - RECENT_WINDOW_MS;
      const rows = this.db
        .query(
          `SELECT tags, created_at
           FROM memories
           WHERE created_at > ? AND tags != '[]'
           ORDER BY created_at DESC`,
        )
        .all(cutoff) as TagsTimestampRow[];

      // Track the most recent mention of each tag
      const topicLastSeen = new Map<string, number>();
      for (const row of rows) {
        const tags = parseTags(row.tags);
        for (const tag of tags) {
          const normalized = tag.toLowerCase().trim();
          if (normalized.length === 0) continue;
          const existing = topicLastSeen.get(normalized);
          if (existing === undefined || row.created_at > existing) {
            topicLastSeen.set(normalized, row.created_at);
          }
        }
      }

      const sorted = [...topicLastSeen.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_RECENT_TOPICS);

      return sorted.map(([topic, lastMentioned]) => ({ topic, lastMentioned }));
    } catch (err) {
      this.logger.error("getRecentTopics", "Failed to query recent topics", err);
      return [];
    }
  }

  private getSkills(): ReadonlyArray<ProfileSkill> {
    try {
      const rows = this.db
        .query(
          `SELECT content, confidence
           FROM memories
           WHERE type = 'skill'
           ORDER BY confidence DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(MAX_SKILLS) as ContentConfidenceRow[];

      return rows.map((row) => ({
        name: extractSkillName(row.content),
        level: inferSkillLevel(row.content),
      }));
    } catch (err) {
      this.logger.error("getSkills", "Failed to query skills", err);
      return [];
    }
  }

  private getDecisionPatterns(): ReadonlyArray<ProfileDecisionPattern> {
    try {
      const rows = this.db
        .query(
          `SELECT content, confidence
           FROM memories
           WHERE type = 'decision'
           ORDER BY confidence DESC, updated_at DESC
           LIMIT ?`,
        )
        .all(MAX_DECISION_PATTERNS * 5) as ContentConfidenceRow[]; // fetch extra to group

      // Group similar decisions by first ~40 characters as a rough key
      const groups = new Map<string, { pattern: string; count: number }>();
      for (const row of rows) {
        const key = row.content.slice(0, 40).toLowerCase().trim();
        const existing = groups.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          groups.set(key, { pattern: extractPattern(row.content), count: 1 });
        }
      }

      const sorted = [...groups.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_DECISION_PATTERNS);

      return sorted.map(({ pattern, count }) => ({ pattern, examples: count }));
    } catch (err) {
      this.logger.error("getDecisionPatterns", "Failed to query decision patterns", err);
      return [];
    }
  }

  private buildSummary(
    preferences: ReadonlyArray<ProfilePreference>,
    interests: ReadonlyArray<ProfileInterest>,
    recentTopics: ReadonlyArray<ProfileRecentTopic>,
  ): string {
    const parts: string[] = [];

    if (interests.length > 0) {
      const topInterests = interests.slice(0, 3).map((i) => i.topic);
      parts.push(`interested in ${topInterests.join(", ")}`);
    }

    if (preferences.length > 0) {
      const topPrefs = preferences.slice(0, 3).map((p) => p.key.replace(/\n/g, " ").trim());
      parts.push(`prefers ${topPrefs.join("; ")}`);
    }

    if (recentTopics.length > 0) {
      const topRecent = recentTopics.slice(0, 3).map((t) => t.topic);
      parts.push(`recent focus: ${topRecent.join(", ")}`);
    }

    if (parts.length === 0) {
      return `${this.ownerName}'s profile is still being built from conversations.`;
    }

    return `${this.ownerName} is ${parts.join(". ")}.`;
  }
}
