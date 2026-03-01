/**
 * Barrel export for the self-learning module.
 */

export { DeduplicationChecker } from "./deduplication.js";
export type { CreateDiscoveryInput, Discovery, DiscoveryStatus, SourceType } from "./discovery.js";
export { DiscoveryEngine } from "./discovery.js";
export type { RelevanceConfig, RelevanceResult, RelevanceScorerFn } from "./relevance.js";
export { RelevanceFilter } from "./relevance.js";
export type { SafetyLevel, SafetyResult } from "./safety.js";
export { SafetyClassifier } from "./safety.js";
