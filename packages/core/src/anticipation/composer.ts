/**
 * ActionComposer -- composes user-facing notifications from enriched contexts.
 * Supports template mode (zero LLM cost) and optional LLM mode.
 */

import type { AnticipationConfig, PatternType } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { EnrichedContext } from "./enricher.ts";
import { renderTemplate } from "./templates.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComposedSuggestion {
  readonly patternType: PatternType;
  readonly title: string;
  readonly body: string;
  readonly priority: "critical" | "normal" | "low";
  readonly channelId: string;
  readonly actionable: boolean;
  readonly suggestedAction?: string;
}

// ---------------------------------------------------------------------------
// Priority mapping
// ---------------------------------------------------------------------------

function getPriority(ctx: EnrichedContext): "critical" | "normal" | "low" {
  // Meeting prep within 15 minutes gets high priority
  if (ctx.pattern.type === "meeting_prep") {
    const minutesUntil = ctx.pattern.metadata.minutesUntil;
    if (typeof minutesUntil === "number" && minutesUntil <= 15) {
      return "critical";
    }
  }
  return "normal";
}

/** Determine if a suggestion is actionable and what the suggested action is. */
function getActionInfo(ctx: EnrichedContext): { actionable: boolean; suggestedAction?: string } {
  switch (ctx.pattern.type) {
    case "health_nudge":
      return {
        actionable: true,
        suggestedAction: `Erinnerung fuer ${getMetadataStr(ctx, "suggestedTime", "18:00")} setzen`,
      };
    case "follow_up":
      return {
        actionable: true,
        suggestedAction: "Jetzt erledigen",
      };
    case "birthday_reminder":
      return {
        actionable: true,
        suggestedAction: "Glueckwuensche senden",
      };
    default:
      return { actionable: false };
  }
}

function getMetadataStr(ctx: EnrichedContext, key: string, fallback: string): string {
  const val = ctx.pattern.metadata[key];
  return typeof val === "string" ? val : fallback;
}

// ---------------------------------------------------------------------------
// ActionComposer
// ---------------------------------------------------------------------------

export class ActionComposer {
  private readonly config: AnticipationConfig;
  private readonly logger: Logger;

  constructor(config: AnticipationConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** Compose a notification from an enriched context. */
  async compose(ctx: EnrichedContext): Promise<ComposedSuggestion> {
    if (this.config.compositionMode === "llm") {
      return this.composeLlm(ctx);
    }
    return this.composeTemplate(ctx);
  }

  /** Compose multiple suggestions. */
  async composeAll(contexts: readonly EnrichedContext[]): Promise<ComposedSuggestion[]> {
    const results: ComposedSuggestion[] = [];
    for (const ctx of contexts) {
      try {
        const suggestion = await this.compose(ctx);
        results.push(suggestion);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn("anticipation-composer", `Failed to compose ${ctx.pattern.type}: ${msg}`);
      }
    }
    return results;
  }

  private composeTemplate(ctx: EnrichedContext): ComposedSuggestion {
    const { title, body } = renderTemplate(ctx);
    const priority = getPriority(ctx);
    const { actionable, suggestedAction } = getActionInfo(ctx);

    return {
      patternType: ctx.pattern.type,
      title,
      body,
      priority,
      channelId: this.config.channel,
      actionable,
      suggestedAction,
    };
  }

  /** LLM composition stub -- Phase 2 will add actual LLM call. */
  private async composeLlm(ctx: EnrichedContext): Promise<ComposedSuggestion> {
    // For now, fall back to template mode.
    // Phase 2 will inject IClaudeProcess and use it for natural-sounding text.
    this.logger.debug("anticipation-composer", "LLM mode not yet implemented, using templates");
    return this.composeTemplate(ctx);
  }
}
