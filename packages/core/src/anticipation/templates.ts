/**
 * Notification templates for each pattern type.
 * Templates are in German (user preference) with data interpolation.
 */

import type { PatternType } from "@eidolon/protocol";
import type { EnrichedContext } from "./enricher.ts";

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

interface TemplateDefinition {
  readonly title: (ctx: EnrichedContext) => string;
  readonly body: (ctx: EnrichedContext) => string;
}

const TEMPLATES: Record<PatternType, TemplateDefinition> = {
  meeting_prep: {
    title: (ctx) => {
      const minutes = getMetadata(ctx, "minutesUntil", "?");
      const entities = ctx.pattern.relevantEntities.join(", ");
      return `Meeting mit ${entities} in ${minutes} Minuten`;
    },
    body: (ctx) => {
      const lines: string[] = [];
      const eventTitle = getMetadata(ctx, "eventTitle", "");
      if (eventTitle) lines.push(`Termin: ${eventTitle}`);

      if (ctx.relatedMemories.length > 0) {
        lines.push("Letzte Gespraeche:");
        for (const mem of ctx.relatedMemories.slice(0, 3)) {
          const summary = mem.memory.content.length > 80 ? `${mem.memory.content.slice(0, 77)}...` : mem.memory.content;
          lines.push(`  - ${summary}`);
        }
      }

      if (ctx.calendarContext) {
        lines.push(`\nKalender: ${ctx.calendarContext.slice(0, 200)}`);
      }

      return lines.join("\n");
    },
  },

  travel_prep: {
    title: (ctx) => {
      const destination = getMetadata(ctx, "destination", "unbekannt");
      return `Reise nach ${destination} morgen`;
    },
    body: (ctx) => {
      const lines: string[] = [];
      const eventTitle = getMetadata(ctx, "eventTitle", "");
      if (eventTitle) lines.push(`Termin: ${eventTitle}`);

      // Phase 1: no weather provider, just a hint
      lines.push("Wetter: Wetterdaten werden in einer zukuenftigen Version verfuegbar sein.");

      if (ctx.relatedMemories.length > 0) {
        lines.push("Fruehere Besuche:");
        for (const mem of ctx.relatedMemories.slice(0, 2)) {
          const summary = mem.memory.content.length > 80 ? `${mem.memory.content.slice(0, 77)}...` : mem.memory.content;
          lines.push(`  - ${summary}`);
        }
      }

      return lines.join("\n");
    },
  },

  health_nudge: {
    title: () => "Taeglich trainieren",
    body: (ctx) => {
      const suggestedTime = getMetadata(ctx, "suggestedTime", "18:00");
      return `Du hast heute noch nicht trainiert. Soll ich eine Erinnerung fuer ${suggestedTime} setzen?`;
    },
  },

  follow_up: {
    title: () => "Follow-Up Erinnerung",
    body: (ctx) => {
      const commitment = getMetadata(ctx, "commitment", "");
      const hoursAgo = getMetadata(ctx, "hoursAgo", "?");
      return `Vor ${hoursAgo} Stunden: "${commitment}"\n\nMoechtest du das noch erledigen?`;
    },
  },

  birthday_reminder: {
    title: (ctx) => {
      const name = getMetadata(ctx, "personName", ctx.pattern.relevantEntities[0] ?? "");
      return `Geburtstag: ${name}`;
    },
    body: (ctx) => {
      const name = getMetadata(ctx, "personName", "");
      const date = getMetadata(ctx, "birthdayDate", "");
      const lines = [`${name} hat bald Geburtstag (${date}).`];
      lines.push("Moechtest du Glueckwuensche senden?");

      if (ctx.relatedMemories.length > 0) {
        lines.push("\nLetzte Interaktionen:");
        for (const mem of ctx.relatedMemories.slice(0, 2)) {
          const summary = mem.memory.content.length > 80 ? `${mem.memory.content.slice(0, 77)}...` : mem.memory.content;
          lines.push(`  - ${summary}`);
        }
      }

      return lines.join("\n");
    },
  },

  routine_deviation: {
    title: () => "Routine-Abweichung erkannt",
    body: () => "Es wurde eine Abweichung von deiner ueblichen Routine erkannt.",
  },

  commute_alert: {
    title: () => "Pendler-Info",
    body: () => "Verkehrsinformationen werden in einer zukuenftigen Version verfuegbar sein.",
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function renderTemplate(ctx: EnrichedContext): { title: string; body: string } {
  const template = TEMPLATES[ctx.pattern.type];
  return {
    title: template.title(ctx),
    body: template.body(ctx),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMetadata(ctx: EnrichedContext, key: string, fallback: string): string {
  const val = ctx.pattern.metadata[key];
  if (typeof val === "string") return val;
  if (typeof val === "number") return String(val);
  return fallback;
}
