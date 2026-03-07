/**
 * FollowUpDetector -- detects unresolved commitments in recent memories.
 * Looks for patterns like "I will", "I'll send", "remind me" in episodes
 * and decisions, and checks if they were followed up on.
 */

import type { AnticipationConfig, Memory } from "@eidolon/protocol";
import type { DetectedPattern, DetectionContext, IPatternDetector } from "../patterns.ts";

const DETECTOR_ID = "follow_up";

/** Patterns that indicate a commitment was made. */
const COMMITMENT_PATTERNS = [
  /\bi(?:'ll| will)\s+(?:send|do|check|follow|write|prepare|finish|review|call|email)/i,
  /\bremind me\b/i,
  /\bfollow up\b/i,
  /\bnot forget\b/i,
  /\bich werde\b/i,
  /\berinner(?:e|t) mich\b/i,
  /\bnachfassen\b/i,
];

export class FollowUpDetector implements IPatternDetector {
  readonly id = DETECTOR_ID;
  readonly name = "Follow-Up Reminder";

  private readonly delayHours: number;

  constructor(config: AnticipationConfig["detectors"]["followUp"]) {
    this.delayHours = config.delayHours;
  }

  async detect(context: DetectionContext): Promise<DetectedPattern[]> {
    const patterns: DetectedPattern[] = [];
    const delayMs = this.delayHours * 3_600_000;

    // Filter memories to decisions and episodes that are old enough
    const candidateMemories = context.recentMemories.filter(
      (m) => (m.type === "decision" || m.type === "episode") && m.createdAt < context.now - delayMs,
    );

    for (const memory of candidateMemories) {
      if (!hasCommitmentPattern(memory.content)) continue;

      // Check if there's a follow-up (newer memory referencing same content)
      const isResolved = context.recentMemories.some(
        (m) => m.id !== memory.id && m.createdAt > memory.createdAt && contentOverlaps(memory.content, m.content),
      );

      if (isResolved) continue;

      // Extract a short summary of the commitment
      const summary = extractCommitmentSummary(memory.content);

      patterns.push({
        detectorId: DETECTOR_ID,
        type: "follow_up",
        confidence: 0.75,
        relevantEntities: [],
        metadata: {
          memoryId: memory.id,
          commitment: summary,
          madeAt: memory.createdAt,
          hoursAgo: Math.round((context.now - memory.createdAt) / 3_600_000),
        },
      });
    }

    return patterns;
  }
}

function hasCommitmentPattern(content: string): boolean {
  return COMMITMENT_PATTERNS.some((p) => p.test(content));
}

/** Check if two memory contents share significant keywords. */
function contentOverlaps(original: string, candidate: string): boolean {
  const words = original
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 4);
  if (words.length === 0) return false;

  const candidateLower = candidate.toLowerCase();
  const matchCount = words.filter((w) => candidateLower.includes(w)).length;
  return matchCount / words.length > 0.3;
}

/** Extract the first sentence containing a commitment pattern. */
function extractCommitmentSummary(content: string): string {
  const sentences = content
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const sentence of sentences) {
    if (COMMITMENT_PATTERNS.some((p) => p.test(sentence))) {
      return sentence.length > 120 ? `${sentence.slice(0, 117)}...` : sentence;
    }
  }
  return content.length > 120 ? `${content.slice(0, 117)}...` : content;
}
