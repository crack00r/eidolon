/**
 * Webhook routing handlers for the Gateway server.
 * Extracted from server.ts to keep files under 300 lines.
 *
 * Handles:
 * - WhatsApp webhook verification and message delivery
 * - Generic webhook endpoint routing with event bus publishing
 */

import type { GatewayConfig } from "@eidolon/protocol";
import type { WhatsAppChannel } from "../channels/whatsapp/channel.ts";
import {
  handleVerificationChallenge,
  parseWebhookPayload,
  verifyWebhookSignature,
} from "../channels/whatsapp/webhook.ts";
import type { Logger } from "../logging/logger.ts";
import type { EventBus } from "../loop/event-bus.ts";
import { secureResponse } from "./server-helpers.ts";
import { extractWebhookResult, handleWebhookRequest, type WebhookDeps } from "./webhook.ts";

// ---------------------------------------------------------------------------
// WhatsApp webhook state
// ---------------------------------------------------------------------------

export interface WhatsAppWebhookState {
  channel: WhatsAppChannel | undefined;
  verifyToken: string | undefined;
  appSecret: string | undefined;
}

// ---------------------------------------------------------------------------
// WhatsApp webhook handler
// ---------------------------------------------------------------------------

export async function handleWhatsAppWebhook(
  req: Request,
  state: WhatsAppWebhookState,
  logger: Logger,
  isTls: boolean,
): Promise<Response> {
  if (req.method === "GET") {
    const url = new URL(req.url);
    if (!state.verifyToken) return secureResponse("WhatsApp webhook not configured", 503, isTls);
    const result = handleVerificationChallenge(url.searchParams, state.verifyToken);
    if (result.ok) {
      logger.info("whatsapp-webhook", "Verification challenge accepted");
      return secureResponse(result.value, 200, isTls);
    }
    logger.warn("whatsapp-webhook", `Verification failed: ${result.error.message}`);
    return secureResponse("Verification failed", 403, isTls);
  }

  if (req.method === "POST") {
    if (!state.channel || !state.appSecret) {
      return secureResponse("WhatsApp webhook not configured", 503, isTls);
    }

    // Body size limit: 1 MB (same as generic webhook handler)
    const MAX_WHATSAPP_BODY_BYTES = 1_048_576;
    const contentLength = req.headers.get("Content-Length");
    if (contentLength !== null) {
      const size = parseInt(contentLength, 10);
      if (!Number.isNaN(size) && size > MAX_WHATSAPP_BODY_BYTES) {
        return secureResponse("Payload too large", 413, isTls);
      }
    }

    let bodyText: string;
    try {
      const bodyBuffer = await req.arrayBuffer();
      if (bodyBuffer.byteLength > MAX_WHATSAPP_BODY_BYTES) {
        return secureResponse("Payload too large", 413, isTls);
      }
      bodyText = new TextDecoder().decode(bodyBuffer);
    } catch {
      // Intentional: body read failure returns 400
      return secureResponse("Failed to read body", 400, isTls);
    }

    const signature = req.headers.get("X-Hub-Signature-256") ?? "";
    const signatureValid = await verifyWebhookSignature(bodyText, signature, state.appSecret);
    if (!signatureValid) {
      logger.warn("whatsapp-webhook", "Invalid webhook signature");
      return secureResponse("Invalid signature", 401, isTls);
    }

    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      // Intentional: malformed JSON returns 400
      return secureResponse("Invalid JSON", 400, isTls);
    }

    const parseResult = parseWebhookPayload(body);
    if (!parseResult.ok) {
      logger.warn("whatsapp-webhook", `Payload parse error: ${parseResult.error.message}`);
      return secureResponse("OK", 200, isTls);
    }

    if (parseResult.value.length > 0) {
      state.channel.handleWebhookEvents(parseResult.value).catch((err: unknown) => {
        logger.error("whatsapp-webhook", "Error handling webhook events", err);
      });
    }

    return secureResponse("OK", 200, isTls);
  }

  return secureResponse("Method not allowed", 405, isTls);
}

// ---------------------------------------------------------------------------
// Generic webhook route handler
// ---------------------------------------------------------------------------

export async function handleWebhookRoute(
  req: Request,
  endpointId: string,
  config: GatewayConfig,
  logger: Logger,
  eventBus: EventBus,
  isTls: boolean,
): Promise<Response> {
  const endpoints = config.webhooks?.endpoints ?? [];
  const endpointConfig = endpoints.find((ep) => ep.id === endpointId);

  if (!endpointConfig) return secureResponse("Not found", 404, isTls);
  if (!endpointConfig.enabled) return secureResponse("Not found", 404, isTls);

  let resolvedToken: string | undefined;
  if (endpointConfig) {
    resolvedToken = typeof endpointConfig.token === "string" ? endpointConfig.token : undefined;
  } else {
    resolvedToken = typeof config.auth.token === "string" ? config.auth.token : undefined;
  }

  const deps: WebhookDeps = { logger, gatewayToken: resolvedToken };
  const response = await handleWebhookRequest(req, deps);

  const result = extractWebhookResult(response);
  if (result) {
    const priority = endpointConfig?.priority ?? "normal";
    const rawEventType = endpointConfig?.eventType ?? "webhook:received";
    const eventType = (rawEventType.startsWith("webhook:") ? rawEventType : "webhook:received") as "webhook:received";

    eventBus.publish(
      eventType,
      {
        webhookId: result.id,
        endpointId,
        source: result.payload.source,
        event: result.payload.event,
        data: result.payload.data,
      },
      { priority, source: `webhook:${endpointId}` },
    );

    logger.info("webhook", `Published ${eventType} from endpoint "${endpointId}"`, {
      webhookId: result.id,
      source: result.payload.source,
      event: result.payload.event,
      priority,
    });
  }

  return response;
}
