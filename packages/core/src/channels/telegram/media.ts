/**
 * Telegram media handling utilities.
 *
 * Downloads files from Telegram's servers and converts them
 * to the protocol MessageAttachment format.
 */

import type { MessageAttachment } from "@eidolon/protocol";

/** Telegram Bot API file download base URL. */
const TELEGRAM_FILE_URL = "https://api.telegram.org/file/bot";

/**
 * Download a Telegram file to a Uint8Array buffer.
 *
 * Uses the Telegram Bot API's getFile endpoint to resolve the file path,
 * then fetches the binary content.
 */
export async function downloadTelegramFile(botToken: string, filePath: string): Promise<Uint8Array> {
  const url = `${TELEGRAM_FILE_URL}${botToken}/${filePath}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download Telegram file: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Convert raw file data to a protocol MessageAttachment.
 */
export function toAttachment(
  type: MessageAttachment["type"],
  mimeType: string,
  data: Uint8Array,
  filename?: string,
): MessageAttachment {
  return {
    type,
    mimeType,
    data,
    ...(filename ? { filename } : {}),
    size: data.byteLength,
  };
}
