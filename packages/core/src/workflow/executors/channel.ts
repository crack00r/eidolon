/**
 * Channel send step executor.
 *
 * Sends messages via the MessageRouter to any configured channel.
 */

import { randomUUID } from "node:crypto";
import type { EidolonError, OutboundMessage, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { MessageRouter } from "../../channels/router.ts";
import type { IStepExecutor, StepConfig, StepOutput, WorkflowContext } from "../types.ts";
import { ChannelSendConfigSchema } from "../types.ts";

export interface ChannelExecutorDeps {
  readonly messageRouter: MessageRouter;
}

export class ChannelStepExecutor implements IStepExecutor {
  readonly type = "channel_send" as const;

  constructor(private readonly deps: ChannelExecutorDeps) {}

  async execute(
    config: StepConfig,
    _context: WorkflowContext,
    signal: AbortSignal,
  ): Promise<Result<StepOutput, EidolonError>> {
    const parsed = ChannelSendConfigSchema.safeParse(config);
    if (!parsed.success) {
      return Err(createError(ErrorCode.CONFIG_INVALID, `Invalid channel_send config: ${parsed.error.message}`));
    }

    if (signal.aborted) {
      return Err(createError(ErrorCode.TIMEOUT, "Step was aborted before execution"));
    }

    const { channelId, message, format } = parsed.data;

    try {
      const outbound: OutboundMessage = {
        id: randomUUID(),
        channelId,
        text: message,
        format: format ?? "text",
      };
      const sendResult = await this.deps.messageRouter.sendNotification(outbound);
      if (!sendResult.ok) {
        return Err(sendResult.error);
      }
      return Ok({ data: { sent: sendResult.value, channelId }, tokensUsed: 0 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Err(createError(ErrorCode.CHANNEL_SEND_FAILED, `Channel send failed: ${msg}`, err));
    }
  }
}
