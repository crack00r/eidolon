export type { CompressionConfig, CompressorOptions, SummarizeFn } from "./compression.ts";
export { MemoryCompressor } from "./compression.ts";
export type { ConsolidationConfig, ConsolidatorOptions, ContradictionDetectorFn } from "./consolidation.ts";
export { MemoryConsolidator } from "./consolidation.ts";
export type { DocumentChunk, IndexingOptions } from "./document-indexer.ts";
export { DocumentIndexer } from "./document-indexer.ts";
export * from "./dreaming/index.ts";
export type { EmbeddingModelOptions, EmbeddingPrefix } from "./embeddings.ts";
export { EmbeddingModel } from "./embeddings.ts";
export type { ConsentCheckFn, ConversationTurn, ExtractedMemory, ExtractorOptions, LlmExtractFn } from "./extractor.ts";
export { MemoryExtractor } from "./extractor.ts";
export type { CreateEdgeInput, EdgeRelation, GraphWalkResult } from "./graph.ts";
export { GraphMemory } from "./graph.ts";
export type { InjectionContext, MemoryInjectorOptions } from "./injector.ts";
export { MemoryInjector } from "./injector.ts";
export * from "./knowledge-graph/index.ts";
export type { ObsidianIndexerOptions, ObsidianIndexResult } from "./obsidian.ts";
export { ObsidianIndexer, parseObsidianTags, parseWikilinks } from "./obsidian.ts";
export type {
  ProfileDecisionPattern,
  ProfileInterest,
  ProfilePreference,
  ProfileRecentTopic,
  ProfileRelationship,
  ProfileSkill,
  UserProfile,
} from "./profile.ts";
export { formatProfileMarkdown, UserProfileGenerator } from "./profile.ts";
export type { MemorySearchOptions } from "./search.ts";
export { MemorySearch } from "./search.ts";
export type { CreateMemoryInput, MemoryListOptions, UpdateMemoryInput } from "./store.ts";
export { MemoryStore } from "./store.ts";
export type { ExtractionResponse, StructuredExtractOptions } from "./structured-extract.ts";
export { createStructuredLlmExtractFn, ExtractionResponseSchema } from "./structured-extract.ts";
