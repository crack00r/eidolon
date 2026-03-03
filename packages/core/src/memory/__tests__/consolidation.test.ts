import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import { runMigrations } from "../../database/migrations.ts";
import { MEMORY_MIGRATIONS } from "../../database/schemas/memory.ts";
import type { Logger } from "../../logging/logger.ts";
import { MemoryConsolidator } from "../consolidation.ts";
import type { EmbeddingModel, EmbeddingPrefix } from "../embeddings.ts";
import type { ExtractedMemory } from "../extractor.ts";
import { type CreateMemoryInput, MemoryStore } from "../store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const result = runMigrations(db, "memory", MEMORY_MIGRATIONS, createSilentLogger());
  if (!result.ok) {
    throw new Error(`Migration failed: ${result.error.message}`);
  }
  return db;
}

function makeExtracted(overrides?: Partial<ExtractedMemory>): ExtractedMemory {
  return {
    type: "fact",
    content: "Manuel prefers TypeScript",
    confidence: 0.9,
    tags: ["preference", "language"],
    source: "rule_based",
    sensitive: false,
    ...overrides,
  };
}

function makeInput(overrides?: Partial<CreateMemoryInput>): CreateMemoryInput {
  return {
    type: "fact",
    layer: "short_term",
    content: "Manuel prefers TypeScript",
    confidence: 0.9,
    source: "extraction:rule_based",
    tags: ["preference", "language"],
    ...overrides,
  };
}

/**
 * Create a fake embedding model that returns a controlled embedding.
 * The embedding function uses a simple hash of the content to produce
 * deterministic vectors, allowing us to control similarity.
 */
function createFakeEmbeddingModel(options?: {
  embedFn?: (text: string, prefix: EmbeddingPrefix) => Promise<Result<Float32Array, EidolonError>>;
}): EmbeddingModel {
  const defaultEmbedFn = async (_text: string): Promise<Result<Float32Array, EidolonError>> => {
    // Generate a simple deterministic embedding from text hash
    const vec = new Float32Array(384);
    let hash = 0;
    for (let i = 0; i < _text.length; i++) {
      hash = (hash * 31 + _text.charCodeAt(i)) | 0;
    }
    for (let i = 0; i < 384; i++) {
      hash = (hash * 1103515245 + 12345) | 0;
      vec[i] = ((hash >> 16) & 0x7fff) / 32767.0 - 0.5;
    }
    // Normalize
    let norm = 0;
    for (let i = 0; i < 384; i++) {
      norm += (vec[i] as number) * (vec[i] as number);
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < 384; i++) {
        vec[i] = (vec[i] as number) / norm;
      }
    }
    return Ok(vec);
  };

  const embedFn = options?.embedFn ?? defaultEmbedFn;

  return {
    isInitialized: true,
    initialize: async () => Ok(undefined),
    embed: embedFn,
    embedBatch: async () => Ok([]),
  } as unknown as EmbeddingModel;
}

/**
 * Create a fake embedding model that always returns the SAME fixed vector,
 * producing similarity of 1.0 against any stored memory with the same vector.
 */
function createIdenticalEmbeddingModel(): EmbeddingModel {
  const fixedVec = new Float32Array(384);
  // Create a normalized unit vector
  fixedVec[0] = 1.0;
  for (let i = 1; i < 384; i++) {
    fixedVec[i] = 0.0;
  }

  return {
    isInitialized: true,
    initialize: async () => Ok(undefined),
    embed: async () => Ok(new Float32Array(fixedVec)),
    embedBatch: async () => Ok([]),
  } as unknown as EmbeddingModel;
}

/**
 * Store a memory with its embedding directly in the DB.
 */
function storeMemoryWithEmbedding(
  db: Database,
  store: MemoryStore,
  input: CreateMemoryInput,
  embedding: Float32Array,
): string {
  const result = store.create(input);
  if (!result.ok) throw new Error(`Failed to create memory: ${result.error.message}`);
  const id = result.value.id;

  // Store the embedding as a blob
  const embeddingBytes = new Uint8Array(embedding.buffer);
  db.query("UPDATE memories SET embedding = ? WHERE id = ?").run(embeddingBytes, id);

  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MemoryConsolidator", () => {
  let db: Database;
  let store: MemoryStore;
  const logger = createSilentLogger();

  beforeEach(() => {
    db = createTestDb();
    store = new MemoryStore(db, logger);
  });

  afterEach(() => {
    db.close();
  });

  // -- classify() -----------------------------------------------------------

  test("classify() returns ADD when no similar memories exist", async () => {
    const embeddingModel = createFakeEmbeddingModel();
    const consolidator = new MemoryConsolidator(store, embeddingModel, logger);

    const result = await consolidator.classify(makeExtracted());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.action).toBe("ADD");
    expect(result.value.content).toBe("Manuel prefers TypeScript");
    expect(result.value.confidence).toBe(0.9);
  });

  test("classify() returns NOOP when near-duplicate exists (sim >= duplicateThreshold)", async () => {
    const embeddingModel = createIdenticalEmbeddingModel();
    const consolidator = new MemoryConsolidator(store, embeddingModel, logger, {
      config: {
        enabled: true,
        duplicateThreshold: 0.95,
        updateThreshold: 0.85,
        maxCandidates: 10,
      },
    });

    // Store a memory with the same fixed embedding
    const fixedVec = new Float32Array(384);
    fixedVec[0] = 1.0;
    storeMemoryWithEmbedding(db, store, makeInput(), fixedVec);

    const result = await consolidator.classify(makeExtracted());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.action).toBe("NOOP");
    expect(result.value.memoryId).toBeDefined();
  });

  test("classify() returns ADD when consolidation is disabled", async () => {
    const embeddingModel = createFakeEmbeddingModel();
    const consolidator = new MemoryConsolidator(store, embeddingModel, logger, {
      config: {
        enabled: false,
        duplicateThreshold: 0.95,
        updateThreshold: 0.85,
        maxCandidates: 10,
      },
    });

    const result = await consolidator.classify(makeExtracted());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.action).toBe("ADD");
    expect(result.value.reason).toContain("disabled");
  });

  test("classify() returns UPDATE when similar memory exists in update range", async () => {
    // Create an embedding model that returns similar-but-not-identical vectors
    let callCount = 0;
    const embeddingModel = createFakeEmbeddingModel({
      embedFn: async () => {
        callCount++;
        const vec = new Float32Array(384);
        // Create a vector that's similar (cosine ~0.92) but not identical
        vec[0] = 1.0;
        // Add small perturbation only for the "incoming" embedding
        if (callCount > 0) {
          vec[1] = 0.15;
        }
        // Normalize
        let norm = 0;
        for (let i = 0; i < 384; i++) {
          norm += (vec[i] as number) * (vec[i] as number);
        }
        norm = Math.sqrt(norm);
        for (let i = 0; i < 384; i++) {
          vec[i] = (vec[i] as number) / norm;
        }
        return Ok(vec);
      },
    });

    const consolidator = new MemoryConsolidator(store, embeddingModel, logger, {
      config: {
        enabled: true,
        duplicateThreshold: 0.99,
        updateThreshold: 0.8,
        maxCandidates: 10,
      },
    });

    // Store a memory with a base vector
    const baseVec = new Float32Array(384);
    baseVec[0] = 1.0;
    storeMemoryWithEmbedding(db, store, makeInput(), baseVec);

    const result = await consolidator.classify(makeExtracted({ content: "Manuel likes TypeScript a lot" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.action).toBe("UPDATE");
    expect(result.value.memoryId).toBeDefined();
  });

  test("classify() returns DELETE when contradiction is detected", async () => {
    // Use fixed embedding so similarity is 1.0
    const embeddingModel = createIdenticalEmbeddingModel();
    const consolidator = new MemoryConsolidator(store, embeddingModel, logger, {
      config: {
        enabled: true,
        // Set thresholds so 1.0 similarity falls in the update range (not NOOP)
        duplicateThreshold: 1.1, // impossible to reach, forces into update/delete path
        updateThreshold: 0.8,
        maxCandidates: 10,
      },
      contradictionDetectorFn: async () => true, // Always detect contradiction
    });

    const fixedVec = new Float32Array(384);
    fixedVec[0] = 1.0;
    storeMemoryWithEmbedding(db, store, makeInput({ content: "Manuel prefers Python" }), fixedVec);

    const result = await consolidator.classify(
      makeExtracted({ content: "Manuel doesn't prefer Python, he prefers TypeScript" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.action).toBe("DELETE");
    expect(result.value.memoryId).toBeDefined();
    expect(result.value.content).toContain("TypeScript");
  });

  // -- consolidate() --------------------------------------------------------

  test("consolidate() processes a batch and returns action counts", async () => {
    const embeddingModel = createFakeEmbeddingModel();
    const consolidator = new MemoryConsolidator(store, embeddingModel, logger);

    const extracted: ExtractedMemory[] = [
      makeExtracted({ content: "Fact one" }),
      makeExtracted({ content: "Fact two" }),
      makeExtracted({ content: "Fact three" }),
    ];

    const result = await consolidator.consolidate(extracted);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.added).toBe(3);
    expect(result.value.decisions).toHaveLength(3);
    expect(result.value.noops).toBe(0);
    expect(result.value.updated).toBe(0);
    expect(result.value.deleted).toBe(0);
  });

  test("consolidate() actually creates memories in the store for ADD decisions", async () => {
    const embeddingModel = createFakeEmbeddingModel();
    const consolidator = new MemoryConsolidator(store, embeddingModel, logger);

    const extracted: ExtractedMemory[] = [
      makeExtracted({ content: "Test memory one" }),
      makeExtracted({ content: "Test memory two" }),
    ];

    const result = await consolidator.consolidate(extracted, "session-123");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify memories were created in the store
    const countResult = store.count();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(2);
  });

  test("consolidate() with DELETE removes old memory and adds new one", async () => {
    const embeddingModel = createIdenticalEmbeddingModel();
    const consolidator = new MemoryConsolidator(store, embeddingModel, logger, {
      config: {
        enabled: true,
        duplicateThreshold: 1.1,
        updateThreshold: 0.8,
        maxCandidates: 10,
      },
      contradictionDetectorFn: async () => true,
    });

    // Store initial memory
    const fixedVec = new Float32Array(384);
    fixedVec[0] = 1.0;
    const oldId = storeMemoryWithEmbedding(db, store, makeInput({ content: "Manuel uses Python" }), fixedVec);

    const result = await consolidator.consolidate([makeExtracted({ content: "Manuel doesn't use Python anymore" })]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.deleted).toBe(1);
    expect(result.value.added).toBe(1); // DELETE also counts as ADD

    // Old memory should be gone
    const getResult = store.get(oldId);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value).toBeNull();

    // New memory should exist (old one deleted + new one created = 1 total)
    const countResult = store.count();
    expect(countResult.ok).toBe(true);
    if (!countResult.ok) return;
    expect(countResult.value).toBe(1);
  });

  // -- heuristicContradiction -----------------------------------------------

  test("heuristicContradiction detects negation patterns", () => {
    expect(
      MemoryConsolidator.heuristicContradiction("Manuel prefers TypeScript", "Manuel doesn't prefer TypeScript"),
    ).toBe(true);

    expect(MemoryConsolidator.heuristicContradiction("Manuel uses Vim", "Manuel does not use Vim")).toBe(true);

    expect(MemoryConsolidator.heuristicContradiction("Manuel likes Python", "Manuel doesn't like Python")).toBe(true);
  });

  test("heuristicContradiction returns false for non-contradictory content", () => {
    expect(MemoryConsolidator.heuristicContradiction("Manuel prefers TypeScript", "Manuel also likes JavaScript")).toBe(
      false,
    );

    expect(MemoryConsolidator.heuristicContradiction("The weather is sunny", "Bun is a fast runtime")).toBe(false);
  });

  test("heuristicContradiction detects correction patterns with word overlap", () => {
    expect(
      MemoryConsolidator.heuristicContradiction(
        "Manuel prefers Python for backend development",
        "Actually, Manuel prefers TypeScript for backend development",
      ),
    ).toBe(true);

    expect(
      MemoryConsolidator.heuristicContradiction(
        "The project uses webpack for bundling",
        "That's wrong, the project uses esbuild for bundling",
      ),
    ).toBe(true);
  });
});
