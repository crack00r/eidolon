/**
 * Learning/research event handlers: research:started.
 * Split from event-handlers.ts to keep files under 300 lines.
 */

import type { Logger } from "../logging/logger.ts";
import type { EventHandlerResult } from "../loop/cognitive-loop.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Handler: research:started
// ---------------------------------------------------------------------------

export async function handleResearchStarted(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  try {
    const rawPayload = event.payload as Record<string, unknown>;
    const researchId = typeof rawPayload.researchId === "string" ? rawPayload.researchId : undefined;
    const query = typeof rawPayload.query === "string" ? rawPayload.query : undefined;
    const deliverTo = typeof rawPayload.deliverTo === "string" ? rawPayload.deliverTo : undefined;

    if (!query) {
      logger.warn("loop-handler", "Invalid research:started payload: missing query", { eventId: event.id });
      return { success: false, tokensUsed: 0, error: "Invalid payload: missing query" };
    }

    const researchEngine = modules.researchEngine;
    if (!researchEngine) {
      logger.warn("loop-handler", "Cannot process research: ResearchEngine not initialized");
      return { success: false, tokensUsed: 0, error: "ResearchEngine not initialized" };
    }

    // Parse sources from payload (string array or default)
    const rawSources = Array.isArray(rawPayload.sources) ? rawPayload.sources : ["web"];
    const sources = rawSources.filter((s): s is string => typeof s === "string");

    const maxSources =
      typeof rawPayload.maxSources === "number" && rawPayload.maxSources > 0 ? rawPayload.maxSources : 10;

    logger.info("loop-handler", `Starting research: "${query}"`, {
      eventId: event.id,
      researchId,
      sources,
      maxSources,
      deliverTo,
    });

    // Run the research
    const result = await researchEngine.research({
      query,
      sources: sources as ReadonlyArray<"web" | "academic" | "github" | "hackernews" | "reddit">,
      maxSources,
      deliverTo,
    });

    if (!result.ok) {
      logger.error("loop-handler", `Research failed: ${result.error.message}`, undefined, {
        researchId,
        errorCode: result.error.code,
      });

      // Emit research:failed event
      modules.eventBus?.publish(
        "research:failed",
        {
          researchId: researchId ?? event.id,
          query,
          error: result.error.message,
        },
        { priority: "low", source: "research" },
      );

      return { success: false, tokensUsed: 0, error: result.error.message };
    }

    const research = result.value;

    // Store each finding as a long-term memory
    if (modules.memoryStore) {
      for (const finding of research.findings) {
        const content = `[Research] ${finding.title}\n\n${finding.summary}`;
        const tags = ["research", ...sources];
        if (finding.citations.length > 0) {
          tags.push("cited");
        }

        const createResult = modules.memoryStore.create({
          type: "fact",
          layer: "long_term",
          content,
          confidence: finding.confidence,
          source: `research:${research.id}`,
          tags,
          metadata: {
            researchId: research.id,
            query,
            citations: finding.citations.map((c) => ({
              url: c.url,
              title: c.title,
              source: c.source,
            })),
          },
        });

        if (!createResult.ok) {
          logger.warn("loop-handler", `Failed to store research finding: ${createResult.error.message}`);
        }
      }

      logger.info("loop-handler", `Stored ${research.findings.length} research findings in memory`);
    }

    // Emit research:completed event
    modules.eventBus?.publish(
      "research:completed",
      {
        researchId: research.id,
        query,
        findingsCount: research.findings.length,
        citationsCount: research.citations.length,
        tokensUsed: research.tokensUsed,
        durationMs: research.durationMs,
        summary: research.summary,
      },
      { priority: "low", source: "research" },
    );

    // Deliver results to a channel if requested
    if (deliverTo && modules.messageRouter) {
      const summaryText = [
        `**Research Complete: ${query}**`,
        "",
        research.summary,
        "",
        `_${research.findings.length} findings, ${research.citations.length} citations, ${research.durationMs}ms_`,
      ].join("\n");

      const sendResult = await modules.messageRouter.sendNotification(
        {
          id: `research-${research.id}`,
          channelId: deliverTo,
          text: summaryText,
          format: "markdown",
        },
        "normal",
      );

      if (!sendResult.ok) {
        logger.warn("loop-handler", `Failed to deliver research to ${deliverTo}: ${sendResult.error.message}`);
      }
    }

    logger.info("loop-handler", "Research completed successfully", {
      researchId: research.id,
      findingsCount: research.findings.length,
      tokensUsed: research.tokensUsed,
      durationMs: research.durationMs,
    });

    return { success: true, tokensUsed: research.tokensUsed };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error("loop-handler", `research:started handler failed: ${errMsg}`);
    return { success: false, tokensUsed: 0, error: errMsg };
  }
}
