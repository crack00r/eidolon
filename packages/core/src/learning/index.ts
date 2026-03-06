/**
 * Barrel export for the self-learning module.
 */

export { DeduplicationChecker } from "./deduplication.ts";
export type { CreateDiscoveryInput, Discovery, DiscoveryStatus, SourceType } from "./discovery.ts";
export { DiscoveryEngine } from "./discovery.ts";
export type {
  ImplementationResult,
  ImplementationRunOptions,
  ImplementationStep,
  ImplementFn,
  RunCommandFn,
} from "./implementation.ts";
export { ImplementationPipeline } from "./implementation.ts";
export type { JournalEntry, JournalEntryType } from "./journal.ts";
export { LearningJournal } from "./journal.ts";
export type { RelevanceConfig, RelevanceResult, RelevanceScorerFn } from "./relevance.ts";
export { RelevanceFilter } from "./relevance.ts";
export type { SafetyLevel, SafetyResult } from "./safety.ts";
export { SafetyClassifier } from "./safety.ts";
export type { RelevanceResponse, StructuredRelevanceOptions } from "./structured-relevance.ts";
export { createStructuredRelevanceScorerFn, RelevanceResponseSchema } from "./structured-relevance.ts";
export type { RouterRelevanceOptions } from "./router-relevance.ts";
export { createRouterRelevanceScorerFn } from "./router-relevance.ts";
export {
  createRunCommandFn,
  createImplementFn,
  createGitWorktree,
  removeGitWorktree,
} from "./pipeline-factory.ts";
export type { CrawledItem, CrawlerSourceConfig, CrawlOptions } from "./crawlers/index.ts";
export {
  ArxivCrawler,
  BaseCrawler,
  CrawlerRegistry,
  GitHubCrawler,
  HackerNewsCrawler,
  RedditCrawler,
  RssCrawler,
  sanitizeContent,
} from "./crawlers/index.ts";
