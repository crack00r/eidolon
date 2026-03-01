/**
 * Telegram media handling utilities.
 *
 * Downloads files from Telegram's servers and converts them
 * to the protocol MessageAttachment format.
 */

import path from "node:path";
import type { MessageAttachment } from "@eidolon/protocol";

/** Telegram Bot API file download base URL. */
const TELEGRAM_FILE_URL = "https://api.telegram.org/file/bot";

/**
 * Check whether a filename segment contains unsafe characters.
 * Rejects characters forbidden on common platforms plus control characters.
 */
function hasUnsafeChars(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    // Control characters (0x00-0x1F)
    if (code <= 0x1f) return true;
    // Platform-forbidden characters: < > : " | ? *
    if (
      code === 0x3c ||
      code === 0x3e ||
      code === 0x3a ||
      code === 0x22 ||
      code === 0x7c ||
      code === 0x3f ||
      code === 0x2a
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Validate and sanitize a Telegram file path to prevent path traversal.
 *
 * Ensures the resolved path stays within a virtual "files/" base directory
 * and does not contain directory traversal sequences.
 *
 * @throws Error if the path is invalid or attempts traversal.
 */
export function sanitizeTelegramFilePath(filePath: string): string {
  // Reject empty paths
  if (!filePath || filePath.trim().length === 0) {
    throw new Error("Telegram file path is empty");
  }

  // Reject null bytes (poison null byte attack)
  if (filePath.includes("\0")) {
    throw new Error("Telegram file path contains null bytes");
  }

  // Normalize and resolve relative to a virtual base to detect traversal
  const virtualBase = "/telegram-files";
  const resolved = path.posix.resolve(virtualBase, filePath);

  // Ensure the resolved path is within the virtual base
  if (!resolved.startsWith(`${virtualBase}/`)) {
    throw new Error(`Telegram file path traversal detected: ${filePath}`);
  }

  // Extract the safe relative path (strip the virtual base prefix)
  const safePath = resolved.slice(virtualBase.length + 1);

  // Sanitize individual path segments
  const segments = safePath.split("/");
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error(`Telegram file path contains traversal segment: ${segment}`);
    }
    if (hasUnsafeChars(segment)) {
      throw new Error(`Telegram file path contains unsafe characters: ${segment}`);
    }
  }

  return safePath;
}

/**
 * Download a Telegram file to a Uint8Array buffer.
 *
 * Uses the Telegram Bot API's getFile endpoint to resolve the file path,
 * then fetches the binary content.
 *
 * @throws Error if the file path fails validation or the download fails.
 */
/** Maximum allowed file download size: 25 MB. */
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/** Timeout for Telegram file downloads: 30 seconds. */
const DOWNLOAD_TIMEOUT_MS = 30_000;

export async function downloadTelegramFile(botToken: string, filePath: string): Promise<Uint8Array> {
  const safePath = sanitizeTelegramFilePath(filePath);
  const url = `${TELEGRAM_FILE_URL}${botToken}/${safePath}`;

  // Finding #7: Add 30-second abort timeout
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "error", // Finding #8: Prevent open redirects
    });

    if (!response.ok) {
      throw new Error(`Failed to download Telegram file: ${response.status} ${response.statusText}`);
    }

    // Finding #9: Check Content-Length before reading body
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const size = Number(contentLength);
      if (!Number.isNaN(size) && size > MAX_FILE_SIZE_BYTES) {
        throw new Error(`Telegram file too large: ${size} bytes (max ${MAX_FILE_SIZE_BYTES})`);
      }
    }

    const buffer = await response.arrayBuffer();

    // Also check actual size after download (Content-Length can be absent or wrong)
    if (buffer.byteLength > MAX_FILE_SIZE_BYTES) {
      throw new Error(`Telegram file too large: ${buffer.byteLength} bytes (max ${MAX_FILE_SIZE_BYTES})`);
    }

    return new Uint8Array(buffer);
  } finally {
    clearTimeout(timer);
  }
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
