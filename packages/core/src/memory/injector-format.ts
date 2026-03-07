/**
 * Memory injector markdown formatting -- extracted from injector.ts.
 *
 * Formats collected memories and Knowledge Graph context into
 * a MEMORY.md markdown string for Claude Code workspace injection.
 */

import type { Memory, MemoryType } from "@eidolon/protocol";
import type { ContextProvider } from "./injector.ts";
import type { TripleResult } from "./knowledge-graph/relations.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Display labels for memory types. */
const TYPE_LABELS: Record<MemoryType, string> = {
  fact: "Facts",
  preference: "Preferences",
  decision: "Decisions",
  episode: "Episodes",
  skill: "Skills",
  relationship: "Relationships",
  schema: "Schemas",
};

/** Desired display order for memory type sections. */
const TYPE_ORDER: readonly MemoryType[] = [
  "fact",
  "preference",
  "decision",
  "skill",
  "episode",
  "relationship",
  "schema",
];

/**
 * Sanitize user-sourced content before embedding in Markdown.
 * Escapes Markdown special characters and replaces newlines with spaces
 * to prevent prompt injection via memory content or KG triple names.
 */
function sanitizeForMarkdown(text: string): string {
  return text.replace(/\n/g, " ").replace(/[#*\->`[\]\\`<]/g, (ch) => `\\${ch}`);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Aggregated Knowledge Graph context for MEMORY.md injection. */
export interface KnowledgeGraphContext {
  readonly triples: readonly TripleResult[];
  readonly communitySummaries: readonly string[];
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format the complete MEMORY.md content from memories and KG context. */
export function formatMemoryMarkdown(
  staticContext: string | undefined,
  memories: readonly Memory[],
  kgContext: KnowledgeGraphContext,
  contextProviders: readonly ContextProvider[],
): string {
  const sections: string[] = ["# Memory Context"];
  const { triples, communitySummaries } = kgContext;

  // Static context
  if (staticContext) {
    sections.push("");
    sections.push(sanitizeForMarkdown(staticContext));
  }

  // No content at all
  if (memories.length === 0 && triples.length === 0 && communitySummaries.length === 0 && !staticContext) {
    sections.push("");
    sections.push("No relevant memories found for this context.");
    return `${sections.join("\n")}\n`;
  }

  // Group memories by type
  if (memories.length > 0) {
    const grouped = groupByType(memories);

    sections.push("");
    sections.push("## Key Memories");

    for (const type of TYPE_ORDER) {
      const group = grouped.get(type);
      if (!group || group.length === 0) continue;

      const label = TYPE_LABELS[type];
      sections.push("");
      sections.push(`### ${label}`);
      for (const memory of group) {
        sections.push(`- ${sanitizeForMarkdown(memory.content)}`);
      }
    }
  }

  // Knowledge Graph Context (triples + communities)
  if (triples.length > 0 || communitySummaries.length > 0) {
    sections.push("");
    sections.push("## Knowledge Graph Context");

    if (triples.length > 0) {
      for (const triple of triples) {
        const subject = sanitizeForMarkdown(triple.subject);
        const predicate = sanitizeForMarkdown(triple.predicate);
        const object = sanitizeForMarkdown(triple.object);
        sections.push(`- ${subject} ${predicate} ${object} (confidence: ${triple.confidence})`);
      }
    }

    if (communitySummaries.length > 0) {
      sections.push("");
      sections.push("### Related Clusters");
      for (const summary of communitySummaries) {
        sections.push(`- ${summary}`);
      }
    }
  }

  // Append context providers (HA state, calendar schedule, etc.)
  for (const provider of contextProviders) {
    const result = provider();
    if (result.ok && result.value.length > 0) {
      sections.push("");
      sections.push(result.value);
    }
  }

  return `${sections.join("\n")}\n`;
}

/** Group memories by their type. */
export function groupByType(memories: readonly Memory[]): Map<MemoryType, Memory[]> {
  const grouped = new Map<MemoryType, Memory[]>();

  for (const memory of memories) {
    const existing = grouped.get(memory.type);
    if (existing) {
      existing.push(memory);
    } else {
      grouped.set(memory.type, [memory]);
    }
  }

  return grouped;
}

/**
 * Sanitize text for community summary display.
 * Exported for use by collectKnowledgeGraphContext in injector.ts.
 */
export { sanitizeForMarkdown };
