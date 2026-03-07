/**
 * Prompt builders for NREM phase LLM calls.
 */

// ---------------------------------------------------------------------------
// Community summary prompt
// ---------------------------------------------------------------------------

export function buildCommunitySummaryPrompt(communityName: string, structuralSummary: string): string {
  return [
    `Summarize this knowledge graph community in 1-2 sentences.`,
    `The summary should capture what this cluster of entities represents`,
    `and why they are related.`,
    "",
    `Community: ${communityName}`,
    "",
    `Structural details:`,
    structuralSummary,
    "",
    `Write a concise summary (1-2 sentences):`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rule abstraction prompt
// ---------------------------------------------------------------------------

export function buildRuleAbstractionPrompt(type: string, contents: readonly string[]): string {
  const numbered = contents
    .slice(0, 10)
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  return [
    `Given these ${contents.length} specific memories of type "${type}",`,
    `abstract a general rule or pattern that captures the underlying principle.`,
    "",
    `Memories:`,
    numbered,
    contents.length > 10 ? `... and ${contents.length - 10} more.` : "",
    "",
    `Abstract a general rule or pattern (1-2 sentences):`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Skill extraction prompt
// ---------------------------------------------------------------------------

export function buildSkillExtractionPrompt(tags: readonly string[], contents: readonly string[]): string {
  const numbered = contents
    .slice(0, 8)
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");

  return [
    `These ${contents.length} memories share the tags [${tags.join(", ")}]`,
    `and describe repeated actions or decisions.`,
    "",
    `Memories:`,
    numbered,
    contents.length > 8 ? `... and ${contents.length - 8} more.` : "",
    "",
    `Extract a reusable skill or procedure from this pattern.`,
    `Describe it as a step-by-step procedure that could be followed in similar situations:`,
  ].join("\n");
}
