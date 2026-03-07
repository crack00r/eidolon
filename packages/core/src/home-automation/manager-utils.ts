/**
 * HAManager utility functions -- extracted from manager.ts.
 *
 * Provides row-to-entity conversion, pattern matching, condition evaluation,
 * message interpolation, and text sanitization for home automation.
 */

import type { HAEntity } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// DB row type
// ---------------------------------------------------------------------------

export interface HAEntityRow {
  entity_id: string;
  domain: string;
  friendly_name: string;
  state: string;
  attributes: string;
  last_changed: number;
  synced_at: number;
}

// ---------------------------------------------------------------------------
// Row conversion
// ---------------------------------------------------------------------------

export function rowToEntity(row: HAEntityRow): HAEntity {
  let attributes: Record<string, unknown> = {};
  try {
    attributes = JSON.parse(row.attributes) as Record<string, unknown>;
  } catch {
    // Ignore parse errors
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

// ---------------------------------------------------------------------------
// Pattern matching and condition evaluation
// ---------------------------------------------------------------------------

/** Check if an entity ID matches a glob-like pattern (supports * wildcard). */
export function matchesPattern(entityId: string, pattern: string): boolean {
  if (pattern === "*") return true;
  // Convert glob pattern to regex
  const escapedPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  const regex = new RegExp(`^${escapedPattern}$`);
  return regex.test(entityId);
}

/**
 * Evaluate a simple condition against an entity.
 * Supports: "state == <value>", "state != <value>"
 */
export function evaluateCondition(entity: HAEntity, condition: string): boolean {
  const eqMatch = condition.match(/^state\s*==\s*(.+)$/);
  if (eqMatch) {
    const expected = eqMatch[1]?.trim().replace(/^["']|["']$/g, "");
    return entity.state === expected;
  }

  const neqMatch = condition.match(/^state\s*!=\s*(.+)$/);
  if (neqMatch) {
    const expected = neqMatch[1]?.trim().replace(/^["']|["']$/g, "");
    return entity.state !== expected;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Interpolate {entityId}, {friendlyName}, {state} in a message template. */
export function interpolateMessage(template: string, entity: HAEntity): string {
  return template
    .replace(/\{entityId\}/g, entity.entityId)
    .replace(/\{friendlyName\}/g, entity.friendlyName)
    .replace(/\{state\}/g, entity.state);
}

export function capitalizeFirst(s: string): string {
  if (s.length === 0) return s;
  const first = s[0];
  if (!first) return s;
  return first.toUpperCase() + s.slice(1);
}

/** Sanitize user-sourced content for markdown injection safety. */
export function sanitize(text: string): string {
  return text.replace(/\n/g, " ").replace(/[#*\->`[\]\\`<]/g, (ch) => `\\${ch}`);
}
