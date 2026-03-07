/**
 * Anticipation Engine -- proactive intelligence module.
 * Barrel export for all anticipation types and classes.
 */

export { ActionComposer } from "./composer.ts";
export type { ComposedSuggestion } from "./composer.ts";
export { ContextEnricher } from "./enricher.ts";
export type { EnrichedContext } from "./enricher.ts";
export { SuggestionHistory } from "./history.ts";
export type { SuggestionRecord, SuppressionRecord } from "./history.ts";
export { AnticipationEngine } from "./engine.ts";
export type { AnticipationEngineDeps } from "./engine.ts";
export type { DetectedPattern, DetectionContext, IPatternDetector } from "./patterns.ts";
export { TriggerEvaluator, buildEntityKey } from "./trigger.ts";
export { renderTemplate } from "./templates.ts";
export * from "./detectors/index.ts";
