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
    const parsed: unknown = JSON.parse(row.attributes);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      attributes = parsed as Record<string, unknown>;
    }
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

/** Maximum pattern length to prevent abuse. */
const MAX_PATTERN_LENGTH = 256;

/**
 * Check if an entity ID matches a glob-like pattern (supports * wildcard).
 * Uses string matching instead of regex to avoid ReDoS.
 */
export function matchesPattern(entityId: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.length > MAX_PATTERN_LENGTH) return false;

  // Split on wildcards and match each literal segment in order
  const parts = pattern.split("*");

  // No wildcards -- exact match
  if (parts.length === 1) return entityId === pattern;

  let pos = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === undefined || part === "") continue;

    if (i === 0) {
      // First segment must match at start
      if (!entityId.startsWith(part)) return false;
      pos = part.length;
    } else if (i === parts.length - 1) {
      // Last segment must match at end
      if (!entityId.endsWith(part) || entityId.length - part.length < pos) return false;
    } else {
      // Middle segments must appear in order
      const idx = entityId.indexOf(part, pos);
      if (idx === -1) return false;
      pos = idx + part.length;
    }
  }
  return true;
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

/** Strip markdown/HTML injection patterns from interpolated values. */
function sanitizeInterpolationValue(value: string): string {
  return value
    .replace(/[[\](){}!#*_~`<>|]/g, "")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** Interpolate {entityId}, {friendlyName}, {state} in a message template. */
export function interpolateMessage(template: string, entity: HAEntity): string {
  return template
    .replace(/\{entityId\}/g, sanitizeInterpolationValue(entity.entityId))
    .replace(/\{friendlyName\}/g, sanitizeInterpolationValue(entity.friendlyName))
    .replace(/\{state\}/g, sanitizeInterpolationValue(entity.state));
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
