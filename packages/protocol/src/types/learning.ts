/**
 * Self-learning types: discovery sources, evaluation, and journal entries.
 */

export type DiscoverySourceType = "reddit" | "hackernews" | "github" | "rss" | "arxiv";
export type SafetyLevel = "safe" | "needs_approval" | "dangerous";

export interface Discovery {
  readonly id: string;
  readonly sourceType: DiscoverySourceType;
  readonly url: string;
  readonly title: string;
  readonly content: string;
  readonly relevanceScore: number;
  readonly safetyLevel: SafetyLevel;
  readonly status: "new" | "evaluated" | "approved" | "rejected" | "implemented";
  readonly implementationBranch?: string;
  readonly createdAt: number;
  readonly evaluatedAt?: number;
  readonly implementedAt?: number;
}

export interface LearningJournalEntry {
  readonly id: string;
  readonly discoveryId: string;
  readonly date: string;
  readonly title: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly actionTaken: string;
}
