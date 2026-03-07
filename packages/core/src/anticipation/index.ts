/**
 * Anticipation Engine -- proactive intelligence module.
 * Barrel export for all anticipation types and classes.
 */

export type { ComposedSuggestion } from "./composer.ts";
export { ActionComposer } from "./composer.ts";
export * from "./detectors/index.ts";
export type { AnticipationEngineDeps } from "./engine.ts";
export { AnticipationEngine } from "./engine.ts";
export type { EnrichedContext } from "./enricher.ts";
export { ContextEnricher } from "./enricher.ts";
export type { SuggestionRecord, SuppressionRecord } from "./history.ts";
export { SuggestionHistory } from "./history.ts";
export type { DetectedPattern, DetectionContext, IPatternDetector } from "./patterns.ts";
export { renderTemplate } from "./templates.ts";
export { buildEntityKey, TriggerEvaluator } from "./trigger.ts";
