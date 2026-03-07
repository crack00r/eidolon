/**
 * NREM skill extraction -- extracted from nrem.ts.
 *
 * Identifies recurring patterns in episode/decision memories and
 * uses LLM to extract reusable skill descriptions.
 */

import type { ILLMProvider, Memory } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { MemoryStore } from "../store.ts";
import { buildSkillExtractionPrompt } from "./nrem-prompts.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SKILL_PATTERN_THRESHOLD = 3;
const MAX_SKILL_EXTRACTION_TOKENS = 512;

// ---------------------------------------------------------------------------
// Skill extraction
// ---------------------------------------------------------------------------

/**
 * Extract skill memories from recurring patterns in episode/decision memories.
 * Groups memories by shared tags, then uses LLM to generate skill descriptions.
 */
export async function extractSkills(
  store: MemoryStore,
  provider: ILLMProvider | null,
  logger: Logger,
): Promise<{ count: number; tokens: number }> {
  if (!provider) {
    logger.debug("extractSkills", "No LLM provider available, skipping skill extraction");
    return { count: 0, tokens: 0 };
  }

  const listResult = store.list({
    types: ["episode", "decision"],
    layers: ["long_term"],
    limit: 200,
    orderBy: "created_at",
    order: "desc",
  });
  if (!listResult.ok) return { count: 0, tokens: 0 };

  const memories = listResult.value;
  if (memories.length < SKILL_PATTERN_THRESHOLD) {
    return { count: 0, tokens: 0 };
  }

  const tagGroups = groupBySharedTags(memories);

  let skillsCreated = 0;
  let totalTokens = 0;

  for (const [tagKey, group] of tagGroups) {
    if (group.length < SKILL_PATTERN_THRESHOLD) continue;

    const existingSkills = store.list({
      types: ["skill"],
      layers: ["long_term"],
      limit: 100,
    });
    if (existingSkills.ok) {
      const alreadyExists = existingSkills.value.some((s) => s.tags.some((t) => tagKey.split(",").includes(t)));
      if (alreadyExists) continue;
    }

    const contents = group.map((m) => m.content);
    try {
      const prompt = buildSkillExtractionPrompt(tagKey.split(","), contents);

      const completion = await provider.complete(
        [
          {
            role: "system",
            content:
              "You are an assistant that extracts reusable procedures and skills from repeated patterns. Respond with ONLY the skill description, no preamble.",
          },
          { role: "user", content: prompt },
        ],
        { temperature: 0.3, maxTokens: MAX_SKILL_EXTRACTION_TOKENS },
      );

      totalTokens += completion.usage.inputTokens + completion.usage.outputTokens;

      const skillContent = completion.content.trim();
      if (skillContent.length > 0) {
        const createResult = store.create({
          type: "skill",
          layer: "procedural",
          content: skillContent,
          confidence: 0.75,
          source: "dreaming:nrem",
          tags: tagKey
            .split(",")
            .map((t) => t.trim())
            .filter((t) => t.length > 0),
        });

        if (createResult.ok) {
          skillsCreated++;
          logger.debug("extractSkills", `Extracted skill from ${group.length} memories`, {
            tags: tagKey,
          });
        }
      }
    } catch (error) {
      logger.warn("extractSkills", "Skill extraction failed for tag group", {
        tags: tagKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { count: skillsCreated, tokens: totalTokens };
}

// ---------------------------------------------------------------------------
// Tag grouping helper
// ---------------------------------------------------------------------------

/** Group memories by shared tags, deduplicating within each group. */
export function groupBySharedTags(memories: readonly Memory[]): Map<string, Memory[]> {
  const tagIndex = new Map<string, Memory[]>();

  for (const mem of memories) {
    for (const tag of mem.tags) {
      const list = tagIndex.get(tag) ?? [];
      list.push(mem);
      tagIndex.set(tag, list);
    }
  }

  const groups = new Map<string, Memory[]>();
  for (const [tag, mems] of tagIndex) {
    if (mems.length >= SKILL_PATTERN_THRESHOLD) {
      const seen = new Set<string>();
      const unique: Memory[] = [];
      for (const m of mems) {
        if (!seen.has(m.id)) {
          seen.add(m.id);
          unique.push(m);
        }
      }
      groups.set(tag, unique);
    }
  }

  return groups;
}
