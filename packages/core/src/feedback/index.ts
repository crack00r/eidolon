/**
 * Feedback module -- response rating and quality tracking.
 */
export { CONFIDENCE_ADJUSTMENT, FeedbackStore } from "./store.ts";
export type { FeedbackListOptions, FeedbackSummary, SubmitFeedbackInput } from "./store.ts";
export { registerFeedbackHandlers } from "./gateway-handlers.ts";
export { adjustSessionMemoryConfidence, subscribeFeedbackConfidenceAdjustment } from "./confidence.ts";
