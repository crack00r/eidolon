/**
 * MemoryCompressor -- progressive and hierarchical compression strategies.
 *
 * Progressive: when a memory cluster (same type + overlapping tags) grows
 * past a configurable threshold, older memories are summarized into a single
 * compressed memory. The originals are deleted.
 *
 * Hierarchical: memories are organized into topic groups using tag overlap.
 * Each group is compressed independently, and groups can be further compressed
 * into higher-level summaries.
 */

import type {
  CompressionResult,
  CompressionStrategy,
  EidolonError,
  Memory,
  MemoryType,
  Result,
} from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { CreateMemoryInput, MemoryStore } from "./store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the compressor. */
export interface CompressionConfig {
  /** Compression strategy. "none" disables compression. */
  readonly strategy: CompressionStrategy;
  /** Cluster size threshold that triggers progressive compression. */
  readonly threshold: number;
}

/** Optional LLM-based summarization function. */
export type SummarizeFn = (memories: readonly string[]) => Promise<string>;

export interface CompressorOptions {
  readonly config: CompressionConfig;
  /** LLM-based summarization. If not provided, a simple concatenation is used. */
  readonly summarizeFn?: SummarizeFn;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CompressionConfig = {
  strategy: "none",
  threshold: 10,
};

// ---------------------------------------------------------------------------
// MemoryCompressor
// ---------------------------------------------------------------------------

export class MemoryCompressor {
  private readonly store: MemoryStore;
  private readonly logger: Logger;
  private readonly config: CompressionConfig;
  private readonly summarizeFn?: SummarizeFn;

  constructor(store: MemoryStore, logger: Logger, options?: Partial<CompressorOptions>) {
    this.store = store;
    this.logger = logger.child("compressor");
    this.config = options?.config ?? DEFAULT_CONFIG;
    this.summarizeFn = options?.summarizeFn;
  }

  /**
   * Run compression on the memory store.
   * Returns a summary of what was compressed.
   */
  async compress(): Promise<Result<CompressionResult, EidolonError>> {
    if (this.config.strategy === "none") {
      return Ok({
        memoriesCompressed: 0,
        summariesCreated: 0,
        removedMemoryIds: [],
      });
    }

    switch (this.config.strategy) {
      case "progressive":
        return this.compressProgressive();
      case "hierarchical":
        return this.compressHierarchical();
      default:
        return Ok({
          memoriesCompressed: 0,
          summariesCreated: 0,
          removedMemoryIds: [],
        });
    }
  }

  /**
   * Progressive compression: find memory clusters by type that exceed
   * the threshold, summarize older memories into a single compressed entry.
   */
  private async compressProgressive(): Promise<Result<CompressionResult, EidolonError>> {
    const memoryTypes: MemoryType[] = ["fact", "preference", "decision", "episode", "skill", "relationship", "schema"];

    let totalCompressed = 0;
    let totalSummaries = 0;
    const allRemovedIds: string[] = [];

    for (const type of memoryTypes) {
      const listResult = this.store.list({
        types: [type],
        layers: ["short_term"],
        orderBy: "created_at",
        order: "asc",
        limit: 10_000,
      });

      if (!listResult.ok) {
        this.logger.warn("compressProgressive", `Failed to list memories of type ${type}: ${listResult.error.message}`);
        continue;
      }

      const memories = listResult.value;

      if (memories.length <= this.config.threshold) {
        continue;
      }

      // Compress the oldest memories, keeping the most recent ones
      const keepCount = Math.ceil(this.config.threshold / 2);
      const toCompress = memories.slice(0, memories.length - keepCount);

      if (toCompress.length < 2) continue;

      const compressResult = await this.summarizeAndReplace(toCompress, type);
      if (!compressResult.ok) {
        this.logger.warn("compressProgressive", `Failed to compress ${type}: ${compressResult.error.message}`);
        continue;
      }

      totalCompressed += compressResult.value.memoriesCompressed;
      totalSummaries += compressResult.value.summariesCreated;
      allRemovedIds.push(...compressResult.value.removedMemoryIds);
    }

    this.logger.info("compressProgressive", "Progressive compression complete", {
      compressed: totalCompressed,
      summaries: totalSummaries,
    });

    return Ok({
      memoriesCompressed: totalCompressed,
      summariesCreated: totalSummaries,
      removedMemoryIds: allRemovedIds,
    });
  }

  /**
   * Hierarchical compression: group memories by overlapping tags,
   * then compress each group independently.
   */
  private async compressHierarchical(): Promise<Result<CompressionResult, EidolonError>> {
    const listResult = this.store.list({
      layers: ["short_term"],
      orderBy: "created_at",
      order: "asc",
      limit: 10_000,
    });

    if (!listResult.ok) {
      return Err(listResult.error);
    }

    const memories = listResult.value;

    // Group by primary tag (first tag) as a simple clustering heuristic
    const groups = new Map<string, Memory[]>();
    for (const mem of memories) {
      const primaryTag = mem.tags[0] ?? "__untagged__";
      const group = groups.get(primaryTag);
      if (group) {
        group.push(mem);
      } else {
        groups.set(primaryTag, [mem]);
      }
    }

    let totalCompressed = 0;
    let totalSummaries = 0;
    const allRemovedIds: string[] = [];

    for (const [tag, group] of groups) {
      if (group.length <= this.config.threshold) continue;

      const keepCount = Math.ceil(this.config.threshold / 2);
      const toCompress = group.slice(0, group.length - keepCount);

      if (toCompress.length < 2) continue;

      this.logger.debug("compressHierarchical", `Compressing group '${tag}' (${toCompress.length} memories)`);

      const compressResult = await this.summarizeAndReplace(toCompress, toCompress[0]?.type ?? "fact");
      if (!compressResult.ok) {
        this.logger.warn("compressHierarchical", `Failed to compress group '${tag}': ${compressResult.error.message}`);
        continue;
      }

      totalCompressed += compressResult.value.memoriesCompressed;
      totalSummaries += compressResult.value.summariesCreated;
      allRemovedIds.push(...compressResult.value.removedMemoryIds);
    }

    this.logger.info("compressHierarchical", "Hierarchical compression complete", {
      groups: groups.size,
      compressed: totalCompressed,
      summaries: totalSummaries,
    });

    return Ok({
      memoriesCompressed: totalCompressed,
      summariesCreated: totalSummaries,
      removedMemoryIds: allRemovedIds,
    });
  }

  /**
   * Summarize a set of memories into a single compressed memory,
   * then delete the originals.
   */
  private async summarizeAndReplace(
    memories: readonly Memory[],
    type: MemoryType,
  ): Promise<Result<CompressionResult, EidolonError>> {
    if (memories.length === 0) {
      return Ok({ memoriesCompressed: 0, summariesCreated: 0, removedMemoryIds: [] });
    }

    // Generate summary
    const contents = memories.map((m) => m.content);
    const summary = await this.summarize(contents);

    // Collect all tags from the compressed memories (deduplicated)
    const allTags = new Set<string>();
    for (const mem of memories) {
      for (const tag of mem.tags) {
        allTags.add(tag);
      }
    }
    allTags.add("compressed");

    // Find the highest confidence among the source memories
    const maxConfidence = Math.max(...memories.map((m) => m.confidence));

    // Create the compressed summary memory
    const input: CreateMemoryInput = {
      type,
      layer: "long_term",
      content: summary,
      confidence: maxConfidence,
      source: "compression",
      tags: [...allTags],
      metadata: {
        compressedFrom: memories.map((m) => m.id),
        compressedCount: memories.length,
        compressedAt: Date.now(),
      },
    };

    const createResult = this.store.create(input);
    if (!createResult.ok) {
      return Err(createResult.error);
    }

    // Delete the originals
    const removedIds: string[] = [];
    for (const mem of memories) {
      const deleteResult = this.store.delete(mem.id);
      if (deleteResult.ok) {
        removedIds.push(mem.id);
      } else {
        this.logger.warn("summarizeAndReplace", `Failed to delete memory ${mem.id}: ${deleteResult.error.message}`);
      }
    }

    return Ok({
      memoriesCompressed: removedIds.length,
      summariesCreated: 1,
      removedMemoryIds: removedIds,
    });
  }

  /**
   * Summarize multiple memory contents into a single string.
   * Uses injected LLM summarization function if available,
   * otherwise falls back to simple bullet-point concatenation.
   */
  private async summarize(contents: readonly string[]): Promise<string> {
    if (this.summarizeFn) {
      try {
        return await this.summarizeFn(contents);
      } catch {
        this.logger.warn("summarize", "LLM summarization failed, using fallback concatenation");
      }
    }

    // Fallback: concatenate as bullet points
    return MemoryCompressor.fallbackSummarize(contents);
  }

  /**
   * Simple fallback summarization: deduplicate and concatenate as bullet points.
   * Exported as static for testability.
   */
  static fallbackSummarize(contents: readonly string[]): string {
    // Deduplicate by normalized content
    const seen = new Set<string>();
    const unique: string[] = [];

    for (const c of contents) {
      const normalized = c.trim().toLowerCase();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        unique.push(c.trim());
      }
    }

    if (unique.length === 1) {
      return unique[0] ?? "";
    }

    return `Consolidated from ${unique.length} memories:\n${unique.map((c) => `- ${c}`).join("\n")}`;
  }
}
