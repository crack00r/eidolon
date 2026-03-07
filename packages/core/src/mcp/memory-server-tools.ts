/**
 * MCP tool handler implementations for the Memory MCP Server.
 *
 * Each tool handler validates input with Zod, delegates to the
 * appropriate store/search module, and returns formatted results.
 */

import type { EidolonError, MemoryType, Result } from "@eidolon/protocol";
import { z } from "zod";
import type { KGEntityStore } from "../memory/knowledge-graph/entities.ts";
import type { KGRelationStore } from "../memory/knowledge-graph/relations.ts";
import type { MemorySearch } from "../memory/search.ts";
import type { MemoryStore } from "../memory/store.ts";

// ---------------------------------------------------------------------------
// Zod schemas for tool inputs
// ---------------------------------------------------------------------------

export const MemorySearchInputSchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.number().int().min(1).max(100).optional().default(10),
  type: z.enum(["fact", "preference", "decision", "episode", "skill", "relationship", "schema"]).optional(),
});

export const MemoryAddInputSchema = z.object({
  content: z.string().min(1).max(50000),
  type: z.enum(["fact", "preference", "decision", "episode", "skill", "relationship", "schema"]).default("fact"),
  tags: z.array(z.string()).optional().default([]),
  source: z.string().optional().default("mcp"),
});

export const MemoryListInputSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(20),
  type: z.enum(["fact", "preference", "decision", "episode", "skill", "relationship", "schema"]).optional(),
  offset: z.number().int().min(0).optional().default(0),
});

export const KgQueryInputSchema = z.object({
  entity_name: z.string().min(1).max(500).optional(),
  entity_type: z.enum(["person", "technology", "device", "project", "concept", "place"]).optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
});

// ---------------------------------------------------------------------------
// Tool result types
// ---------------------------------------------------------------------------

export interface ToolResult {
  readonly ok: true;
  readonly text: string;
}

export interface ToolError {
  readonly ok: false;
  readonly error: string;
}

export type ToolOutcome = ToolResult | ToolError;

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export async function toolMemorySearch(
  args: Record<string, unknown>,
  store: MemoryStore,
  search: MemorySearch | null,
): Promise<ToolOutcome> {
  const parsed = MemorySearchInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid parameters: ${parsed.error.message}` };
  }

  if (!search) {
    // Fall back to text-only search
    const textResult = store.searchText(parsed.data.query, parsed.data.limit);
    if (!textResult.ok) {
      return { ok: false, error: `Search failed: ${textResult.error.message}` };
    }

    const results = textResult.value
      .filter((r) => !parsed.data.type || r.memory.type === parsed.data.type)
      .map((r) => ({
        id: r.memory.id,
        type: r.memory.type,
        content: r.memory.content,
        confidence: r.memory.confidence,
        tags: r.memory.tags,
        score: r.rank,
        createdAt: new Date(r.memory.createdAt).toISOString(),
      }));

    return { ok: true, text: JSON.stringify(results, null, 2) };
  }

  const types = parsed.data.type ? [parsed.data.type as MemoryType] : undefined;
  const searchResult = await search.search({
    text: parsed.data.query,
    limit: parsed.data.limit,
    types,
  });

  if (!searchResult.ok) {
    return { ok: false, error: `Search failed: ${searchResult.error.message}` };
  }

  const results = searchResult.value.map((r) => ({
    id: r.memory.id,
    type: r.memory.type,
    content: r.memory.content,
    confidence: r.memory.confidence,
    tags: r.memory.tags,
    score: r.score,
    matchReason: r.matchReason,
    createdAt: new Date(r.memory.createdAt).toISOString(),
  }));

  return { ok: true, text: JSON.stringify(results, null, 2) };
}

export function toolMemoryAdd(
  args: Record<string, unknown>,
  store: MemoryStore,
): ToolOutcome {
  const parsed = MemoryAddInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid parameters: ${parsed.error.message}` };
  }

  const createResult = store.create({
    content: parsed.data.content,
    type: parsed.data.type as MemoryType,
    layer: "long_term",
    confidence: 0.8,
    source: parsed.data.source,
    tags: parsed.data.tags,
  });

  if (!createResult.ok) {
    return { ok: false, error: `Failed to create memory: ${createResult.error.message}` };
  }

  return {
    ok: true,
    text: JSON.stringify(
      {
        id: createResult.value.id,
        content: createResult.value.content,
        type: createResult.value.type,
        createdAt: new Date(createResult.value.createdAt).toISOString(),
      },
      null,
      2,
    ),
  };
}

export function toolMemoryList(
  args: Record<string, unknown>,
  store: MemoryStore,
): ToolOutcome {
  const parsed = MemoryListInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid parameters: ${parsed.error.message}` };
  }

  const types = parsed.data.type ? [parsed.data.type as MemoryType] : undefined;
  const listResult = store.list({
    limit: parsed.data.limit,
    types,
    offset: parsed.data.offset,
    orderBy: "created_at",
    order: "desc",
  });

  if (!listResult.ok) {
    return { ok: false, error: `Failed to list memories: ${listResult.error.message}` };
  }

  const results = listResult.value.map((m) => ({
    id: m.id,
    type: m.type,
    content: m.content,
    confidence: m.confidence,
    tags: m.tags,
    createdAt: new Date(m.createdAt).toISOString(),
  }));

  return { ok: true, text: JSON.stringify(results, null, 2) };
}

export function toolKgQuery(
  args: Record<string, unknown>,
  kgEntities: KGEntityStore | null,
  kgRelations: KGRelationStore | null,
): ToolOutcome {
  const parsed = KgQueryInputSchema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: `Invalid parameters: ${parsed.error.message}` };
  }

  if (!kgEntities) {
    return { ok: false, error: "Knowledge graph is not available" };
  }

  // Find entities by name prefix or type
  let entityResult: Result<
    Array<{ id: string; name: string; type: string; attributes: Record<string, unknown>; createdAt: number }>,
    EidolonError
  >;

  if (parsed.data.entity_name) {
    entityResult = kgEntities.searchByName(parsed.data.entity_name, parsed.data.limit);
  } else if (parsed.data.entity_type) {
    entityResult = kgEntities.findByType(parsed.data.entity_type, parsed.data.limit);
  } else {
    entityResult = kgEntities.list({ limit: parsed.data.limit });
  }

  if (!entityResult.ok) {
    return { ok: false, error: `KG query failed: ${entityResult.error.message}` };
  }

  const entities = entityResult.value;

  // Get triples for found entities
  let triples: Array<{ subject: string; predicate: string; object: string; confidence: number }> = [];
  if (kgRelations && entities.length > 0) {
    const entityIds = entities.map((e) => e.id);
    const triplesResult = kgRelations.getTriplesForEntities(entityIds, parsed.data.limit);
    if (triplesResult.ok) {
      triples = triplesResult.value;
    }
  }

  const result = {
    entities: entities.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      attributes: e.attributes,
      createdAt: new Date(e.createdAt).toISOString(),
    })),
    triples,
  };

  return { ok: true, text: JSON.stringify(result, null, 2) };
}
