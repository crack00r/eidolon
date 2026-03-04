/**
 * WhatsApp media handling utilities.
 *
 * Provides helpers for downloading media from WhatsApp via the Cloud API
 * and converting to the protocol MessageAttachment format.
 */

import type { EidolonError, MessageAttachment, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { WhatsAppApiClient } from "./api.ts";

/** Maximum allowed media download size: 25 MB. */
const MAX_MEDIA_SIZE_BYTES = 25 * 1024 * 1024;

/**
 * Resolve a `whatsapp-media://` URI to actual media bytes.
 *
 * WhatsApp inbound messages contain a media ID, not the actual bytes.
 * This function uses the WhatsApp Cloud API to:
 *  1. Resolve the media ID to a download URL.
 *  2. Download the actual media bytes.
 *
 * @param mediaUri - URI in the format `whatsapp-media://<mediaId>`
 * @param api - WhatsApp API client for making requests
 * @param logger - Logger instance
 * @returns The downloaded media as a Uint8Array, or an error
 */
export async function downloadWhatsAppMedia(
  mediaUri: string,
  api: WhatsAppApiClient,
  logger: Logger,
): Promise<Result<Uint8Array, EidolonError>> {
  const prefix = "whatsapp-media://";
  if (!mediaUri.startsWith(prefix)) {
    return Err(createError(ErrorCode.WHATSAPP_MEDIA_ERROR, `Invalid WhatsApp media URI: ${mediaUri}`));
  }

  const mediaId = mediaUri.slice(prefix.length);
  if (!mediaId) {
    return Err(createError(ErrorCode.WHATSAPP_MEDIA_ERROR, "Empty media ID in WhatsApp media URI"));
  }

  logger.debug("whatsapp-media", "Downloading media", { mediaId });

  const result = await api.downloadMedia(mediaId);
  if (!result.ok) {
    logger.error("whatsapp-media", `Failed to download media: ${result.error.message}`, undefined, { mediaId });
    return result;
  }

  // Enforce size limit
  if (result.value.byteLength > MAX_MEDIA_SIZE_BYTES) {
    return Err(
      createError(
        ErrorCode.WHATSAPP_MEDIA_ERROR,
        `Media too large: ${result.value.byteLength} bytes (max ${MAX_MEDIA_SIZE_BYTES})`,
      ),
    );
  }

  logger.debug("whatsapp-media", "Media downloaded successfully", {
    mediaId,
    size: result.value.byteLength,
  });

  return Ok(result.value);
}

/**
 * Convert a WhatsApp media attachment URI and metadata to a fully resolved
 * MessageAttachment with actual binary data.
 *
 * @param attachment - The attachment with a `whatsapp-media://` URL
 * @param api - WhatsApp API client
 * @param logger - Logger instance
 * @returns A new attachment with `data` populated and `url` removed, or null on failure
 */
export async function resolveWhatsAppAttachment(
  attachment: MessageAttachment,
  api: WhatsAppApiClient,
  logger: Logger,
): Promise<MessageAttachment | null> {
  if (!attachment.url?.startsWith("whatsapp-media://")) {
    return attachment;
  }

  const result = await downloadWhatsAppMedia(attachment.url, api, logger);
  if (!result.ok) {
    logger.error("whatsapp-media", `Failed to resolve attachment: ${result.error.message}`, undefined, {
      url: attachment.url,
    });
    return null;
  }

  return {
    type: attachment.type,
    mimeType: attachment.mimeType,
    data: result.value,
    ...(attachment.filename ? { filename: attachment.filename } : {}),
    size: result.value.byteLength,
  };
}

/**
 * Infer the attachment type from a MIME type string.
 */
export function inferAttachmentType(mimeType: string): MessageAttachment["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}
