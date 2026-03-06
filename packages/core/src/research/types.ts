/**
 * Types for the research engine.
 */

export type ResearchSource = "web" | "academic" | "github" | "hackernews" | "reddit";

export interface ResearchRequest {
  readonly query: string;
  readonly sources: readonly ResearchSource[];
  readonly maxSources: number;
  readonly deliverTo?: string;
}

export interface Citation {
  readonly url: string;
  readonly title: string;
  readonly source: ResearchSource;
  readonly relevance: number;
  readonly snippet: string;
}

export interface ResearchFinding {
  readonly title: string;
  readonly summary: string;
  readonly citations: readonly Citation[];
  readonly confidence: number;
}

export interface ResearchResult {
  readonly id: string;
  readonly query: string;
  readonly findings: readonly ResearchFinding[];
  readonly summary: string;
  readonly citations: readonly Citation[];
  readonly tokensUsed: number;
  readonly durationMs: number;
  readonly completedAt: number;
}

export interface ResearchEngineConfig {
  readonly workspaceDir: string;
  readonly maxSources: number;
  /** Optional model override for the research session. */
  readonly model?: string;
  /** Optional timeout for the research session in milliseconds. */
  readonly timeoutMs?: number;
}
