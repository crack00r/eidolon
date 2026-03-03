/**
 * Markdown formatting for UserProfile.
 *
 * Separated from profile.ts to keep file sizes under the 300-line limit.
 */

import type { UserProfile } from "./profile.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize text for Markdown output: collapse newlines into spaces.
 */
function sanitize(text: string): string {
  return text.replace(/\n/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Formatter
// ---------------------------------------------------------------------------

/** Format a UserProfile into a markdown section for MEMORY.md injection. */
export function formatProfileMarkdown(profile: UserProfile): string {
  const lines: string[] = ["## User Profile", ""];
  lines.push(`**Name:** ${sanitize(profile.name)}`);
  lines.push("");

  if (profile.preferences.length > 0) {
    lines.push("### Preferences");
    for (const pref of profile.preferences) {
      lines.push(`- ${sanitize(pref.key)} (confidence: ${pref.confidence.toFixed(2)})`);
    }
    lines.push("");
  }

  if (profile.interests.length > 0) {
    lines.push("### Interests");
    for (const interest of profile.interests) {
      lines.push(`- ${interest.topic} (mentioned ${interest.mentionCount} times)`);
    }
    lines.push("");
  }

  if (profile.recentTopics.length > 0) {
    lines.push("### Recent Topics");
    for (const topic of profile.recentTopics) {
      const date = new Date(topic.lastMentioned).toISOString().split("T")[0];
      lines.push(`- ${topic.topic} (last: ${date ?? "unknown"})`);
    }
    lines.push("");
  }

  if (profile.skills.length > 0) {
    lines.push("### Skills");
    for (const skill of profile.skills) {
      lines.push(`- ${sanitize(skill.name)} (${skill.level})`);
    }
    lines.push("");
  }

  if (profile.decisionPatterns.length > 0) {
    lines.push("### Decision Patterns");
    for (const dp of profile.decisionPatterns) {
      lines.push(`- ${sanitize(dp.pattern)} (${dp.examples} example${dp.examples === 1 ? "" : "s"})`);
    }
    lines.push("");
  }

  if (profile.summary) {
    lines.push("### Summary");
    lines.push(sanitize(profile.summary));
    lines.push("");
  }

  return lines.join("\n");
}
