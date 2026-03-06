/**
 * Email attachment utilities: filtering, classification, and conversion.
 *
 * Extracted from channel.ts to keep the main EmailChannel class under 300 lines.
 */

import type { MessageAttachment } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";
import type { ImapMessage } from "./imap.ts";
import type { SmtpAttachment } from "./smtp.ts";

// ---------------------------------------------------------------------------
// Attachment type classification
// ---------------------------------------------------------------------------

/** Classify MIME type into MessageAttachment type categories. */
export function classifyAttachmentType(mimeType: string): MessageAttachment["type"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

// ---------------------------------------------------------------------------
// Inbound attachment filtering
// ---------------------------------------------------------------------------

/** Filter inbound email attachments by size limit. */
export function filterAttachments(
  email: ImapMessage,
  maxAttachmentSizeMb: number,
  logger: Logger,
): readonly MessageAttachment[] {
  const maxBytes = maxAttachmentSizeMb * 1024 * 1024;
  const result: MessageAttachment[] = [];

  for (const att of email.attachments) {
    if (att.size > maxBytes) {
      logger.warn("email", "Skipping oversized attachment", {
        filename: att.filename,
        size: att.size,
        maxBytes,
      });
      continue;
    }

    result.push({
      type: classifyAttachmentType(att.mimeType),
      mimeType: att.mimeType,
      data: att.content,
      filename: att.filename,
      size: att.size,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Outbound attachment conversion
// ---------------------------------------------------------------------------

/** Convert outbound message attachments to SMTP format. */
export function convertAttachments(attachments?: readonly MessageAttachment[]): readonly SmtpAttachment[] {
  if (!attachments || attachments.length === 0) return [];

  return attachments
    .filter((a) => a.data)
    .map((a) => ({
      filename: a.filename ?? "attachment",
      mimeType: a.mimeType,
      content: a.data as Uint8Array,
    }));
}
