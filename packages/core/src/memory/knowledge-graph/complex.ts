/**
 * ComplEx knowledge graph embedding training and link prediction.
 *
 * ComplEx represents entities and relations as complex-valued vectors.
 * The scoring function uses the Hermitian dot product:
 *   Re(<h, r, conj(t)>) = sum_i (hRe*rRe*tRe + hIm*rRe*tIm + hRe*rIm*tIm - hIm*rIm*tRe)
 *
 * This naturally models symmetric, antisymmetric, and 1-to-N relations.
 */

import type { Database } from "bun:sqlite";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Triple {
  readonly subject: string;
  readonly predicate: string;
  readonly object: string;
}

export interface PredictedTriple extends Triple {
  readonly score: number;
  readonly source: "prediction";
}

export interface ComplExOptions {
  readonly dimensions?: number;
  readonly epochs?: number;
  readonly learningRate?: number;
  readonly negativeRatio?: number;
}

interface EmbeddingPair {
  re: Float32Array;
  im: Float32Array;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Gaussian random (Box-Muller transform), scaled by 0.1. */
function randomGaussian(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1 || 1e-10)) * Math.cos(2 * Math.PI * u2) * 0.1;
}

function initEmbedding(dims: number): EmbeddingPair {
  const re = new Float32Array(dims);
  const im = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    re[i] = randomGaussian();
    im[i] = randomGaussian();
  }
  return { re, im };
}

function corruptTriple(triple: Triple, entityIds: readonly string[]): Triple {
  const idx = Math.floor(Math.random() * entityIds.length);
  if (Math.random() < 0.5) {
    const newHead = entityIds[idx] as string;
    return { subject: newHead, predicate: triple.predicate, object: triple.object };
  }
  const newTail = entityIds[idx] as string;
  return { subject: triple.subject, predicate: triple.predicate, object: newTail };
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = tmp;
  }
}

function float32ToBlob(arr: Float32Array): Uint8Array {
  return new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
}

function blobToFloat32(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob);
  return new Float32Array(copy.buffer);
}

// ---------------------------------------------------------------------------
// ComplExEmbeddings
// ---------------------------------------------------------------------------

export class ComplExEmbeddings {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly dims: number;
  private readonly epochs: number;
  private readonly learningRate: number;
  private readonly negativeRatio: number;

  constructor(db: Database, logger: Logger, options?: ComplExOptions) {
    this.db = db;
    this.logger = logger.child("complex");
    this.dims = options?.dimensions ?? 64;
    this.epochs = options?.epochs ?? 100;
    this.learningRate = options?.learningRate ?? 0.01;
    this.negativeRatio = options?.negativeRatio ?? 5;
  }

  /** Compute ComplEx score: Re(<h, r, conj(t)>). */
  static complexScore(
    hRe: Float32Array,
    hIm: Float32Array,
    rRe: Float32Array,
    rIm: Float32Array,
    tRe: Float32Array,
    tIm: Float32Array,
  ): number {
    let score = 0;
    for (let i = 0; i < hRe.length; i++) {
      const hR = hRe[i] as number;
      const hI = hIm[i] as number;
      const rR = rRe[i] as number;
      const rI = rIm[i] as number;
      const tR = tRe[i] as number;
      const tI = tIm[i] as number;
      score += hR * rR * tR + hI * rR * tI + hR * rI * tI - hI * rI * tR;
    }
    return score;
  }

  /** Sigmoid function for score normalization. */
  static sigmoid(x: number): number {
    if (x >= 0) {
      return 1 / (1 + Math.exp(-x));
    }
    const expX = Math.exp(x);
    return expX / (1 + expX);
  }

  /** Train ComplEx embeddings on all triples in the KG. */
  train(
    triples: readonly Triple[],
    entityIds: readonly string[],
  ): Result<{ loss: number; epochs: number }, EidolonError> {
    try {
      if (triples.length === 0 || entityIds.length === 0) {
        return Ok({ loss: 0, epochs: 0 });
      }

      const predicates = [...new Set(triples.map((t) => t.predicate))];
      const embeddings = new Map<string, EmbeddingPair>();

      // Initialize random embeddings for entities and predicates
      for (const id of entityIds) {
        embeddings.set(id, initEmbedding(this.dims));
      }
      for (const pred of predicates) {
        embeddings.set(pred, initEmbedding(this.dims));
      }

      const mutableTriples = [...triples];
      let loss = 0;

      for (let epoch = 0; epoch < this.epochs; epoch++) {
        loss = 0;
        shuffleArray(mutableTriples);

        for (const triple of mutableTriples) {
          const hEmb = embeddings.get(triple.subject);
          const rEmb = embeddings.get(triple.predicate);
          const tEmb = embeddings.get(triple.object);
          if (!hEmb || !rEmb || !tEmb) continue;

          // Positive sample
          const posScore = ComplExEmbeddings.complexScore(hEmb.re, hEmb.im, rEmb.re, rEmb.im, tEmb.re, tEmb.im);
          const posSigmoid = ComplExEmbeddings.sigmoid(posScore);
          const posGrad = posSigmoid - 1;
          loss += -Math.log(posSigmoid + 1e-10);

          // Update positive triple embeddings
          this.updateGradients(hEmb, rEmb, tEmb, posGrad);

          // Negative samples
          for (let n = 0; n < this.negativeRatio; n++) {
            const negTriple = corruptTriple(triple, entityIds);
            const negH = embeddings.get(negTriple.subject);
            const negT = embeddings.get(negTriple.object);
            if (!negH || !negT) continue;

            const negScore = ComplExEmbeddings.complexScore(negH.re, negH.im, rEmb.re, rEmb.im, negT.re, negT.im);
            const negSigmoid = ComplExEmbeddings.sigmoid(negScore);
            const negGrad = negSigmoid;
            loss += -Math.log(1 - negSigmoid + 1e-10);

            this.updateGradients(negH, rEmb, negT, negGrad);
          }
        }

        loss /= mutableTriples.length * (1 + this.negativeRatio);
      }

      // Persist all embeddings to database
      this.persistEmbeddings(embeddings);

      this.logger.info("train", `Trained ComplEx embeddings`, {
        entities: entityIds.length,
        predicates: predicates.length,
        triples: triples.length,
        epochs: this.epochs,
        finalLoss: loss,
      });

      return Ok({ loss, epochs: this.epochs });
    } catch (cause) {
      return Err(createError(ErrorCode.EMBEDDING_FAILED, "ComplEx training failed", cause));
    }
  }

  /** Score a single triple (higher = more likely true). */
  score(subject: string, predicate: string, object: string): Result<number, EidolonError> {
    try {
      const hResult = this.getEmbedding(subject);
      if (!hResult.ok) return hResult;
      const rResult = this.getEmbedding(predicate);
      if (!rResult.ok) return rResult;
      const tResult = this.getEmbedding(object);
      if (!tResult.ok) return tResult;

      if (!hResult.value || !rResult.value || !tResult.value) {
        return Err(
          createError(ErrorCode.EMBEDDING_FAILED, `Missing embedding for scoring: ${subject}, ${predicate}, ${object}`),
        );
      }

      const s = ComplExEmbeddings.complexScore(
        hResult.value.real,
        hResult.value.imaginary,
        rResult.value.real,
        rResult.value.imaginary,
        tResult.value.real,
        tResult.value.imaginary,
      );
      return Ok(s);
    } catch (cause) {
      return Err(createError(ErrorCode.EMBEDDING_FAILED, "ComplEx scoring failed", cause));
    }
  }

  /** Predict missing links for an entity. */
  predictLinks(
    entityId: string,
    predicates: readonly string[],
    candidateIds: readonly string[],
    topK: number = 10,
  ): Result<PredictedTriple[], EidolonError> {
    try {
      const entityEmb = this.getEmbedding(entityId);
      if (!entityEmb.ok) return entityEmb;
      if (!entityEmb.value) {
        return Err(createError(ErrorCode.EMBEDDING_FAILED, `No embedding for entity ${entityId}`));
      }

      const results: PredictedTriple[] = [];

      for (const pred of predicates) {
        const rEmb = this.getEmbedding(pred);
        if (!rEmb.ok || !rEmb.value) continue;

        for (const cId of candidateIds) {
          if (cId === entityId) continue;
          const cEmb = this.getEmbedding(cId);
          if (!cEmb.ok || !cEmb.value) continue;

          const s = ComplExEmbeddings.complexScore(
            entityEmb.value.real,
            entityEmb.value.imaginary,
            rEmb.value.real,
            rEmb.value.imaginary,
            cEmb.value.real,
            cEmb.value.imaginary,
          );

          results.push({
            subject: entityId,
            predicate: pred,
            object: cId,
            score: s,
            source: "prediction",
          });
        }
      }

      results.sort((a, b) => b.score - a.score);
      return Ok(results.slice(0, topK));
    } catch (cause) {
      return Err(createError(ErrorCode.EMBEDDING_FAILED, "Link prediction failed", cause));
    }
  }

  /** Store embeddings for an entity or relation predicate. */
  storeEmbedding(id: string, realPart: Float32Array, imagPart: Float32Array): Result<void, EidolonError> {
    try {
      const now = Date.now();
      this.db
        .query(
          `INSERT INTO kg_complex_embeddings (entity_id, real_embedding, imaginary_embedding, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (entity_id) DO UPDATE SET
             real_embedding = excluded.real_embedding,
             imaginary_embedding = excluded.imaginary_embedding,
             updated_at = excluded.updated_at`,
        )
        .run(id, float32ToBlob(realPart), float32ToBlob(imagPart), now);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to store embedding for ${id}`, cause));
    }
  }

  /** Get embeddings for an entity or relation predicate. */
  getEmbedding(id: string): Result<{ real: Float32Array; imaginary: Float32Array } | null, EidolonError> {
    try {
      const row = this.db
        .query(`SELECT real_embedding, imaginary_embedding FROM kg_complex_embeddings WHERE entity_id = ?`)
        .get(id) as { real_embedding: Uint8Array; imaginary_embedding: Uint8Array } | null;

      if (!row) return Ok(null);

      return Ok({
        real: blobToFloat32(row.real_embedding),
        imaginary: blobToFloat32(row.imaginary_embedding),
      });
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get embedding for ${id}`, cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Apply SGD update for a single (h, r, t) triple with the given gradient scalar.
   * The ComplEx scoring is trilinear, so gradients are products of the other two.
   */
  private updateGradients(h: EmbeddingPair, r: EmbeddingPair, t: EmbeddingPair, grad: number): void {
    const lr = this.learningRate;
    for (let i = 0; i < this.dims; i++) {
      const hRe = h.re[i] as number;
      const hIm = h.im[i] as number;
      const rRe = r.re[i] as number;
      const rIm = r.im[i] as number;
      const tRe = t.re[i] as number;
      const tIm = t.im[i] as number;

      // Gradient of score w.r.t. head (real): rRe*tRe + rIm*tIm
      // Gradient of score w.r.t. head (imag): rRe*tIm - rIm*tRe
      h.re[i] = hRe - lr * grad * (rRe * tRe + rIm * tIm);
      h.im[i] = hIm - lr * grad * (rRe * tIm - rIm * tRe);

      // Gradient of score w.r.t. relation (real): hRe*tRe + hIm*tIm
      // Gradient of score w.r.t. relation (imag): hRe*tIm - hIm*tRe
      r.re[i] = rRe - lr * grad * (hRe * tRe + hIm * tIm);
      r.im[i] = rIm - lr * grad * (hRe * tIm - hIm * tRe);

      // Gradient of score w.r.t. tail (real): hRe*rRe - hIm*rIm
      // Gradient of score w.r.t. tail (imag): hIm*rRe + hRe*rIm
      t.re[i] = tRe - lr * grad * (hRe * rRe - hIm * rIm);
      t.im[i] = tIm - lr * grad * (hIm * rRe + hRe * rIm);
    }
  }

  /** Persist all in-memory embeddings to the database. */
  private persistEmbeddings(embeddings: Map<string, EmbeddingPair>): void {
    const stmt = this.db.query(
      `INSERT INTO kg_complex_embeddings (entity_id, real_embedding, imaginary_embedding, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (entity_id) DO UPDATE SET
         real_embedding = excluded.real_embedding,
         imaginary_embedding = excluded.imaginary_embedding,
         updated_at = excluded.updated_at`,
    );

    const now = Date.now();
    const txn = this.db.transaction(() => {
      for (const [id, emb] of embeddings) {
        stmt.run(id, float32ToBlob(emb.re), float32ToBlob(emb.im), now);
      }
    });
    txn();
  }
}
