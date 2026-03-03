/**
 * Extended profile queries for UserProfileGenerator.
 *
 * Queries the memories and knowledge graph tables to extract timezone,
 * languages, devices, and relationships. Separated from profile.ts to
 * keep files under the 300-line limit.
 */

import type { Database } from "bun:sqlite";
import type { ProfileRelationship } from "./profile.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_RELATIONSHIPS = 20;
const MAX_DEVICES = 10;

// ---------------------------------------------------------------------------
// Row shapes from SQLite
// ---------------------------------------------------------------------------

interface RelationshipRow {
  readonly entity_name: string;
  readonly entity_type: string;
  readonly relation_type: string;
  readonly confidence: number;
}

interface EntityNameRow {
  readonly name: string;
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/** Extract IANA timezone from preference memories (e.g., "Europe/Berlin"). */
export function queryTimezone(db: Database): string | undefined {
  try {
    const row = db
      .query(
        `SELECT content FROM memories
         WHERE type = 'preference'
           AND (content LIKE '%timezone%' OR content LIKE '%time zone%' OR content LIKE '%Zeitzone%')
         ORDER BY confidence DESC, updated_at DESC
         LIMIT 1`,
      )
      .get() as { readonly content: string } | null;
    if (!row) return undefined;
    const match = row.content.match(/[A-Z][a-z]+\/[A-Z][a-z_]+/);
    return match ? match[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Extract spoken languages from preference and fact memories. */
export function queryLanguages(db: Database): ReadonlyArray<string> {
  try {
    const rows = db
      .query(
        `SELECT content FROM memories
         WHERE type IN ('preference', 'fact')
           AND (content LIKE '%language%' OR content LIKE '%Sprache%'
             OR content LIKE '%speaks%' OR content LIKE '%spricht%')
         ORDER BY confidence DESC
         LIMIT 10`,
      )
      .all() as ReadonlyArray<{ readonly content: string }>;

    const langs = new Set<string>();
    const langPatterns =
      /\b(German|English|French|Spanish|Italian|Portuguese|Russian|Japanese|Korean|Chinese|Dutch|Polish|Turkish|Arabic|Hindi|Swedish|Norwegian|Danish|Finnish|Czech|Greek|Hebrew|Thai|Vietnamese|Indonesian|Malay|Ukrainian|Romanian|Hungarian)\b/gi;
    for (const row of rows) {
      const matches = row.content.match(langPatterns);
      if (matches) {
        for (const m of matches) {
          langs.add(m.charAt(0).toUpperCase() + m.slice(1).toLowerCase());
        }
      }
    }
    return [...langs];
  } catch {
    return [];
  }
}

/** Extract device names from KG entities or memory content. */
export function queryDevices(db: Database): ReadonlyArray<string> {
  try {
    // Check KG entities of type 'device' first
    const kgRows = db
      .query(`SELECT name FROM kg_entities WHERE type = 'device' ORDER BY updated_at DESC LIMIT ?`)
      .all(MAX_DEVICES) as EntityNameRow[];

    if (kgRows.length > 0) {
      return kgRows.map((r) => r.name);
    }

    // Fallback: search memories for device mentions
    const memRows = db
      .query(
        `SELECT content FROM memories
         WHERE type IN ('fact', 'preference')
           AND (content LIKE '%device%' OR content LIKE '%computer%' OR content LIKE '%laptop%'
             OR content LIKE '%phone%' OR content LIKE '%server%' OR content LIKE '%PC%'
             OR content LIKE '%MacBook%' OR content LIKE '%iPhone%' OR content LIKE '%iPad%')
         ORDER BY confidence DESC
         LIMIT 10`,
      )
      .all() as ReadonlyArray<{ readonly content: string }>;

    const devices = new Set<string>();
    const devicePatterns =
      /\b(MacBook(?:\s+(?:Pro|Air))?|iMac|iPhone|iPad|Ubuntu\s+server|Windows\s+PC|RTX\s+\d{4}|Linux\s+server|Raspberry\s+Pi)\b/gi;
    for (const row of memRows) {
      const matches = row.content.match(devicePatterns);
      if (matches) {
        for (const m of matches) devices.add(m);
      }
    }
    return [...devices].slice(0, MAX_DEVICES);
  } catch {
    return [];
  }
}

/** Extract relationships from the knowledge graph involving the owner. */
export function queryRelationships(db: Database, ownerName: string): ReadonlyArray<ProfileRelationship> {
  try {
    const rows = db
      .query(
        `SELECT e2.name AS entity_name, e2.type AS entity_type,
                r.type AS relation_type, r.confidence
         FROM kg_relations r
         JOIN kg_entities e1 ON r.source_id = e1.id
         JOIN kg_entities e2 ON r.target_id = e2.id
         WHERE LOWER(e1.name) = LOWER(?)
         ORDER BY r.confidence DESC
         LIMIT ?`,
      )
      .all(ownerName, MAX_RELATIONSHIPS) as RelationshipRow[];

    const reverseRows = db
      .query(
        `SELECT e1.name AS entity_name, e1.type AS entity_type,
                r.type AS relation_type, r.confidence
         FROM kg_relations r
         JOIN kg_entities e1 ON r.source_id = e1.id
         JOIN kg_entities e2 ON r.target_id = e2.id
         WHERE LOWER(e2.name) = LOWER(?)
         ORDER BY r.confidence DESC
         LIMIT ?`,
      )
      .all(ownerName, MAX_RELATIONSHIPS) as RelationshipRow[];

    const seen = new Set<string>();
    const results: ProfileRelationship[] = [];

    for (const row of [...rows, ...reverseRows]) {
      const key = `${row.entity_name}:${row.relation_type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        entity: row.entity_name,
        entityType: row.entity_type,
        relation: row.relation_type,
        confidence: row.confidence,
      });
    }

    return results.slice(0, MAX_RELATIONSHIPS);
  } catch {
    return [];
  }
}
