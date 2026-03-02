/**
 * EmbeddingModel -- produces 384-dimensional embedding vectors using
 * multilingual-e5-small via @huggingface/transformers (ONNX runtime).
 *
 * For multilingual-e5 models, text must be prefixed:
 *   - "query: " for search queries
 *   - "passage: " for documents/memories to store
 */

import { join } from "node:path";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import { getCacheDir } from "../config/paths.ts";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Prefix required by multilingual-e5 models. */
export type EmbeddingPrefix = "query" | "passage";

export interface EmbeddingModelOptions {
  readonly modelId?: string;
  readonly dimensions?: number;
  readonly cacheDir?: string;
}

/**
 * Minimal shape of the @huggingface/transformers pipeline output.
 * We use `unknown` instead of importing concrete types to avoid
 * tight coupling and keep the public API type-safe.
 */
interface PipelineOutput {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

/**
 * Shape of a feature-extraction pipeline callable.
 * The pipeline function accepts text(s) and options, returning a tensor-like result.
 */
type FeatureExtractionPipeline = (
  texts: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<PipelineOutput>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL_ID = "Xenova/multilingual-e5-small";
const DEFAULT_DIMENSIONS = 384;

/** Epsilon for floating-point comparison to avoid division by near-zero. */
const COSINE_EPSILON = 1e-10;

// ---------------------------------------------------------------------------
// EmbeddingModel
// ---------------------------------------------------------------------------

export class EmbeddingModel {
  private extractionPipeline: FeatureExtractionPipeline | null = null;
  private initialized = false;
  private readonly modelId: string;
  private readonly dimensions: number;
  private readonly cacheDir: string;
  private readonly logger: Logger;

  constructor(logger: Logger, options?: EmbeddingModelOptions) {
    this.modelId = options?.modelId ?? DEFAULT_MODEL_ID;
    this.dimensions = options?.dimensions ?? DEFAULT_DIMENSIONS;
    this.cacheDir = options?.cacheDir ?? join(getCacheDir(), "models");
    this.logger = logger.child("embeddings");
  }

  /** Load the ONNX model. Must be called before embed/embedBatch. */
  async initialize(): Promise<Result<void, EidolonError>> {
    if (this.initialized) {
      return Ok(undefined);
    }

    const startMs = performance.now();

    try {
      // Dynamic import to avoid loading ONNX runtime at module parse time
      const transformers = await import("@huggingface/transformers");

      // Configure cache directory for model storage
      transformers.env.cacheDir = this.cacheDir;
      // SECURITY NOTE: allowRemoteModels=true enables downloading from Hugging Face Hub
      // on first run. After the initial download, the model is cached locally in cacheDir.
      // This is acceptable for trusted model IDs (e.g. Xenova/multilingual-e5-small).
      // If deploying in a locked-down environment, pre-populate the cache and set
      // allowRemoteModels=false to prevent any network model fetching.
      transformers.env.allowRemoteModels = true;

      this.logger.info("initialize", `Loading embedding model: ${this.modelId}`, {
        cacheDir: this.cacheDir,
      });

      const pipe = await transformers.pipeline("feature-extraction", this.modelId, {
        dtype: "fp32",
      });

      this.extractionPipeline = pipe as unknown as FeatureExtractionPipeline;
      this.initialized = true;

      const elapsedMs = Math.round(performance.now() - startMs);
      this.logger.info("initialize", `Embedding model loaded in ${elapsedMs}ms`, {
        modelId: this.modelId,
        dimensions: this.dimensions,
        elapsedMs,
      });

      return Ok(undefined);
    } catch (cause) {
      this.logger.error("initialize", `Failed to load embedding model: ${this.modelId}`, cause);
      return Err(
        createError(ErrorCode.EMBEDDING_FAILED, `Failed to initialize embedding model: ${this.modelId}`, cause),
      );
    }
  }

  /** Embed a single text. Returns a Float32Array of `dimensions` length. */
  async embed(text: string, prefix: EmbeddingPrefix = "passage"): Promise<Result<Float32Array, EidolonError>> {
    if (!this.initialized || !this.extractionPipeline) {
      return Err(createError(ErrorCode.EMBEDDING_FAILED, "Embedding model not initialized. Call initialize() first."));
    }

    try {
      const prefixedText = `${prefix}: ${text}`;
      const output = await this.extractionPipeline(prefixedText, {
        pooling: "mean",
        normalize: true,
      });

      const embedding = new Float32Array(output.data);

      if (embedding.length !== this.dimensions) {
        return Err(
          createError(ErrorCode.EMBEDDING_FAILED, `Expected ${this.dimensions} dimensions, got ${embedding.length}`),
        );
      }

      return Ok(embedding);
    } catch (cause) {
      this.logger.error("embed", "Failed to embed text", cause);
      return Err(createError(ErrorCode.EMBEDDING_FAILED, "Failed to embed text", cause));
    }
  }

  /** Embed multiple texts at once. Returns an array of Float32Array vectors. */
  async embedBatch(
    texts: readonly string[],
    prefix: EmbeddingPrefix = "passage",
  ): Promise<Result<Float32Array[], EidolonError>> {
    if (!this.initialized || !this.extractionPipeline) {
      return Err(createError(ErrorCode.EMBEDDING_FAILED, "Embedding model not initialized. Call initialize() first."));
    }

    if (texts.length === 0) {
      return Ok([]);
    }

    try {
      const prefixedTexts = texts.map((t) => `${prefix}: ${t}`);
      const output = await this.extractionPipeline(prefixedTexts, {
        pooling: "mean",
        normalize: true,
      });

      // The output.data contains all embeddings concatenated.
      // output.dims should be [batchSize, dimensions].
      const batchSize = texts.length;
      const embeddings: Float32Array[] = [];

      for (let i = 0; i < batchSize; i++) {
        const start = i * this.dimensions;
        const end = start + this.dimensions;
        embeddings.push(new Float32Array(output.data.slice(start, end)));
      }

      return Ok(embeddings);
    } catch (cause) {
      this.logger.error("embedBatch", `Failed to embed batch of ${texts.length} texts`, cause);
      return Err(createError(ErrorCode.EMBEDDING_FAILED, `Failed to embed batch of ${texts.length} texts`, cause));
    }
  }

  /**
   * Compute cosine similarity between two embedding vectors.
   * Since multilingual-e5 outputs are L2-normalized, this reduces to dot product.
   */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const ai = a[i] as number;
      const bi = b[i] as number;
      dotProduct += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    if (denominator < COSINE_EPSILON) return 0;

    return dotProduct / denominator;
  }

  /** Check if the model has been loaded. */
  get isInitialized(): boolean {
    return this.initialized;
  }
}
