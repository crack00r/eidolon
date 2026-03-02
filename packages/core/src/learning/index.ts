/**
 * Barrel export for the self-learning module.
 */

export { DeduplicationChecker } from "./deduplication.ts";
export type { CreateDiscoveryInput, Discovery, DiscoveryStatus, SourceType } from "./discovery.ts";
export { DiscoveryEngine } from "./discovery.ts";
export type { RelevanceConfig, RelevanceResult, RelevanceScorerFn } from "./relevance.ts";
export { RelevanceFilter } from "./relevance.ts";
export type { SafetyLevel, SafetyResult } from "./safety.ts";
export { SafetyClassifier } from "./safety.ts";
