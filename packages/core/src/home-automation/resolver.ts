/**
 * Semantic entity resolver for Home Automation.
 *
 * Resolves natural language input like "Wohnzimmer Licht" to HA entity IDs
 * like "light.living_room" using a combination of:
 *   1. Exact match on entity_id or friendly_name
 *   2. Fuzzy match on domain + name parts
 *   3. Semantic similarity via embedding vectors (optional)
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, HAEntity, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EmbeddingModel } from "../memory/embeddings.ts";

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

interface HAEntityRow {
  entity_id: string;
  domain: string;
  friendly_name: string;
  state: string;
  attributes: string;
  last_changed: number;
  synced_at: number;
}

// ---------------------------------------------------------------------------
// Match result
// ---------------------------------------------------------------------------

export interface ResolveMatch {
  readonly entity: HAEntity;
  readonly score: number;
  readonly matchType: "exact_id" | "exact_name" | "fuzzy" | "semantic";
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEMANTIC_THRESHOLD = 0.6;
const FUZZY_MIN_SCORE = 0.3;

// ---------------------------------------------------------------------------
// HAEntityResolver
// ---------------------------------------------------------------------------

export class HAEntityResolver {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly embeddingModel: EmbeddingModel | null;

  constructor(db: Database, logger: Logger, embeddingModel?: EmbeddingModel) {
    this.db = db;
    this.logger = logger.child("ha-resolver");
    this.embeddingModel = embeddingModel ?? null;
  }

  /**
   * Resolve a natural language entity reference to an HA entity.
   *
   * Tries strategies in order: exact_id, exact_name, fuzzy, semantic.
   * Returns the best match or null if nothing found.
   */
  async resolve(text: string, domain?: string): Promise<Result<HAEntity | null, EidolonError>> {
    try {
      const normalizedText = text.trim().toLowerCase();
      if (normalizedText.length === 0) {
        return Ok(null);
      }

      const entities = this.loadEntities(domain);
      if (entities.length === 0) {
        return Ok(null);
      }

      // 1. Exact match on entity_id
      const exactIdMatch = entities.find((e) => e.entityId.toLowerCase() === normalizedText);
      if (exactIdMatch) {
        this.logger.debug("resolve", `Exact ID match: ${exactIdMatch.entityId}`);
        return Ok(exactIdMatch);
      }

      // 2. Exact match on friendly_name (case-insensitive)
      const exactNameMatch = entities.find((e) => e.friendlyName.toLowerCase() === normalizedText);
      if (exactNameMatch) {
        this.logger.debug("resolve", `Exact name match: ${exactNameMatch.entityId}`);
        return Ok(exactNameMatch);
      }

      // 3. Fuzzy match: check if all words in query appear in entity name or domain
      const fuzzyMatches = this.fuzzyMatch(normalizedText, entities);
      if (fuzzyMatches.length > 0) {
        const bestFuzzy = fuzzyMatches[0];
        if (bestFuzzy && bestFuzzy.score >= FUZZY_MIN_SCORE) {
          this.logger.debug("resolve", `Fuzzy match: ${bestFuzzy.entity.entityId} (score: ${bestFuzzy.score})`);
          return Ok(bestFuzzy.entity);
        }
      }

      // 4. Semantic match via embeddings (if embedding model is available)
      if (this.embeddingModel) {
        const semanticMatch = await this.semanticMatch(normalizedText, entities);
        if (semanticMatch) {
          this.logger.debug("resolve", `Semantic match: ${semanticMatch.entityId}`);
          return Ok(semanticMatch);
        }
      }

      this.logger.debug("resolve", `No match found for: "${text}"`);
      return Ok(null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to resolve entity: "${text}"`, cause));
    }
  }

  /**
   * Resolve multiple entity references from a single text.
   * Splits on common delimiters and resolves each part independently.
   */
  async resolveMultiple(text: string, domain?: string): Promise<Result<HAEntity[], EidolonError>> {
    // Split on "and", "und", commas, semicolons
    const parts = text.split(/\s*(?:,|;|\band\b|\bund\b)\s*/i).filter((p) => p.trim().length > 0);

    const results: HAEntity[] = [];
    for (const part of parts) {
      const result = await this.resolve(part.trim(), domain);
      if (!result.ok) return result;
      if (result.value) {
        results.push(result.value);
      }
    }
    return Ok(results);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private loadEntities(domain?: string): HAEntity[] {
    const query = domain ? "SELECT * FROM ha_entities WHERE domain = ?" : "SELECT * FROM ha_entities";

    const rows = domain
      ? (this.db.query(query).all(domain) as HAEntityRow[])
      : (this.db.query(query).all() as HAEntityRow[]);

    return rows.map(rowToEntity);
  }

  /**
   * Fuzzy matching: score each entity based on word overlap between
   * the query and the entity's friendly name / entity ID.
   */
  private fuzzyMatch(query: string, entities: readonly HAEntity[]): ResolveMatch[] {
    const queryWords = query.split(/\s+/);
    const matches: ResolveMatch[] = [];

    for (const entity of entities) {
      const targetWords = [
        ...entity.friendlyName.toLowerCase().split(/\s+/),
        ...entity.entityId.toLowerCase().replace(/[._]/g, " ").split(/\s+/),
        entity.domain.toLowerCase(),
      ];

      let matchedCount = 0;
      for (const qw of queryWords) {
        if (targetWords.some((tw) => tw.includes(qw) || qw.includes(tw))) {
          matchedCount++;
        }
      }

      const score = queryWords.length > 0 ? matchedCount / queryWords.length : 0;
      if (score > 0) {
        matches.push({ entity, score, matchType: "fuzzy" });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Semantic matching: embed the query and all entity names,
   * find the best cosine-similarity match above the threshold.
   */
  private async semanticMatch(query: string, entities: readonly HAEntity[]): Promise<HAEntity | null> {
    if (!this.embeddingModel) return null;

    const queryEmbResult = await this.embeddingModel.embed(query, "query");
    if (!queryEmbResult.ok) {
      this.logger.warn("semanticMatch", `Embedding failed for query: ${queryEmbResult.error.message}`);
      return null;
    }
    const queryVec = queryEmbResult.value;

    let bestMatch: HAEntity | null = null;
    let bestScore = SEMANTIC_THRESHOLD;

    for (const entity of entities) {
      const entityText = `${entity.friendlyName} ${entity.domain} ${entity.entityId.replace(/[._]/g, " ")}`;
      const entityEmbResult = await this.embeddingModel.embed(entityText, "passage");
      if (!entityEmbResult.ok) continue;

      const score = cosineSimilarity(queryVec, entityEmbResult.value);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = entity;
      }
    }

    return bestMatch;
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function rowToEntity(row: HAEntityRow): HAEntity {
  let attributes: Record<string, unknown> = {};
  try {
    attributes = JSON.parse(row.attributes) as Record<string, unknown>;
  } catch {
    // Ignore parse errors, use empty object
  }

  return {
    entityId: row.entity_id,
    domain: row.domain,
    friendlyName: row.friendly_name,
    state: row.state,
    attributes,
    lastChanged: row.last_changed,
  };
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dotProduct += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator < 1e-10) return 0;
  return dotProduct / denominator;
}
