/**
 * REM ComplEx training and link prediction -- extracted from rem.ts.
 *
 * Trains ComplEx embeddings on all KG triples and predicts new links
 * with high confidence, storing them as new relations.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { Triple } from "../knowledge-graph/complex.ts";
import { ComplExEmbeddings } from "../knowledge-graph/complex.ts";
import type { KGRelationStore, RelationPredicate } from "../knowledge-graph/relations.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_PREDICTION_CONFIDENCE = 0.7;

// ---------------------------------------------------------------------------
// ComplEx training
// ---------------------------------------------------------------------------

/** Collect all triples from KG relations (using entity IDs) and train ComplEx. */
export function trainComplEx(
  complex: ComplExEmbeddings,
  kgRelations: KGRelationStore,
  logger: Logger,
): Result<void, EidolonError> {
  const triplesResult = kgRelations.getAllTriplesWithIds(10000);
  if (!triplesResult.ok) return triplesResult;

  const triples: Triple[] = triplesResult.value.map((t) => ({
    subject: t.subjectId,
    predicate: t.predicate,
    object: t.objectId,
  }));

  if (triples.length === 0) {
    return Ok(undefined);
  }

  const entityIds = [...new Set(triples.flatMap((t) => [t.subject, t.object]))];
  const trainResult = complex.train(triples, entityIds);

  if (!trainResult.ok) return trainResult;

  logger.debug("trainComplEx", "ComplEx training complete", {
    triples: triples.length,
    loss: trainResult.value.loss,
  });

  return Ok(undefined);
}

// ---------------------------------------------------------------------------
// Link prediction
// ---------------------------------------------------------------------------

/**
 * Predict new links using trained ComplEx embeddings and store high-confidence
 * predictions as new relations with source='prediction'.
 */
export function predictAndStoreLinks(
  complex: ComplExEmbeddings,
  kgRelations: KGRelationStore,
  logger: Logger,
): Result<number, EidolonError> {
  const triplesResult = kgRelations.getAllTriplesWithIds(10000);
  if (!triplesResult.ok) return triplesResult;

  if (triplesResult.value.length === 0) {
    return Ok(0);
  }

  const entityIds = [...new Set(triplesResult.value.flatMap((t) => [t.subjectId, t.objectId]))];
  const predicates = [...new Set(triplesResult.value.map((t) => t.predicate))];

  // Build a set of existing triples for fast lookup
  const existingTriples = new Set(triplesResult.value.map((t) => `${t.subjectId}|${t.predicate}|${t.objectId}`));

  let created = 0;

  for (const entityId of entityIds) {
    const predictions = complex.predictLinks(entityId, predicates, entityIds, 5);
    if (!predictions.ok) continue;

    for (const pred of predictions.value) {
      // Skip if triple already exists or score is too low
      const key = `${pred.subject}|${pred.predicate}|${pred.object}`;
      if (existingTriples.has(key)) continue;
      if (pred.score < MIN_PREDICTION_CONFIDENCE) continue;

      // Validate that the predicate is a valid RelationPredicate before creating
      const createResult = kgRelations.create({
        sourceId: pred.subject,
        targetId: pred.object,
        type: pred.predicate as RelationPredicate,
        confidence: Math.min(ComplExEmbeddings.sigmoid(pred.score), 0.9),
        source: "prediction",
      });

      if (createResult.ok) {
        created++;
        existingTriples.add(key);
      }
    }
  }

  logger.debug("predictAndStoreLinks", `Stored ${created} predicted relations`, {
    totalEntities: entityIds.length,
    totalPredicates: predicates.length,
  });

  return Ok(created);
}
