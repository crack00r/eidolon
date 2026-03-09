/**
 * System event handlers: digest:generate.
 * Split from event-handlers.ts to keep files under 300 lines.
 */

import type { Logger } from "../logging/logger.ts";
import type { EventHandlerResult } from "../loop/cognitive-loop.ts";
import type { InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Handler: digest:generate
// ---------------------------------------------------------------------------

export async function handleDigestGenerate(
  modules: InitializedModules,
  event: { readonly id: string; readonly payload: unknown },
  logger: Logger,
): Promise<EventHandlerResult> {
  logger.info("loop-handler", "Digest generation triggered", { eventId: event.id });
  if (!modules.digestBuilder || !modules.messageRouter) {
    logger.warn("loop-handler", "Digest skipped: builder or router not available");
    return { success: true, tokensUsed: 0 };
  }
  const digestResult = modules.digestBuilder.build();
  if (!digestResult.ok) {
    logger.error("loop-handler", `Digest build failed: ${digestResult.error.message}`);
    return { success: false, tokensUsed: 0, error: digestResult.error.message };
  }
  const digest = digestResult.value;
  const digestChannel = modules.config?.digest.channel ?? "telegram";
  const targetChannels =
    digestChannel === "all" ? modules.messageRouter.getChannels().map((c) => c.id) : [digestChannel];
  for (const chId of targetChannels) {
    const sendResult = await modules.messageRouter.sendNotification(
      {
        id: `digest-${digest.generatedAt}-${chId}`,
        channelId: chId,
        text: digest.markdown,
        format: "markdown",
      },
      "normal",
    );
    if (!sendResult.ok) {
      logger.error("loop-handler", `Digest delivery failed to ${chId}: ${sendResult.error.message}`);
    }
  }
  // Emit digest:delivered event
  modules.eventBus?.publish(
    "digest:delivered",
    {
      title: digest.title,
      generatedAt: digest.generatedAt,
      sectionCount: digest.sections.length,
      channels: targetChannels,
    },
    { priority: "low", source: "digest" },
  );
  logger.info("loop-handler", `Digest delivered: ${digest.title} (${digest.sections.length} sections)`);
  return { success: true, tokensUsed: 0 };
}
