/**
 * WhatsApp Cloud API client.
 *
 * Wraps the Meta WhatsApp Business API (v21.0) with Result-pattern returns,
 * retry logic for transient failures, and an injectable interface for testing.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BASE_URL = "https://graph.facebook.com/v21.0";
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Injectable WhatsApp API client interface for testability. */
export interface WhatsAppApiClient {
  sendText(to: string, text: string, replyToId?: string): Promise<Result<string, EidolonError>>;
  sendMedia(
    to: string,
    type: "image" | "document" | "audio" | "video",
    mediaUrl: string,
    caption?: string,
  ): Promise<Result<string, EidolonError>>;
  markAsRead(messageId: string): Promise<Result<void, EidolonError>>;
  downloadMedia(mediaId: string): Promise<Result<Uint8Array, EidolonError>>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WhatsAppApiConfig {
  readonly phoneNumberId: string;
  readonly accessToken: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class WhatsAppCloudApi implements WhatsAppApiClient {
  private readonly phoneNumberId: string;
  private readonly accessToken: string;
  private readonly logger: Logger;

  constructor(config: WhatsAppApiConfig, logger: Logger) {
    this.phoneNumberId = config.phoneNumberId;
    this.accessToken = config.accessToken;
    this.logger = logger;
  }

  async sendText(to: string, text: string, replyToId?: string): Promise<Result<string, EidolonError>> {
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    };

    if (replyToId) {
      body.context = { message_id: replyToId };
    }

    return this.sendMessage(body);
  }

  async sendMedia(
    to: string,
    type: "image" | "document" | "audio" | "video",
    mediaUrl: string,
    caption?: string,
  ): Promise<Result<string, EidolonError>> {
    const mediaPayload: Record<string, unknown> = { link: mediaUrl };
    if (caption && (type === "image" || type === "document" || type === "video")) {
      mediaPayload.caption = caption;
    }

    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type,
      [type]: mediaPayload,
    };

    return this.sendMessage(body);
  }

  async markAsRead(messageId: string): Promise<Result<void, EidolonError>> {
    const body = {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    };

    const result = await this.apiRequest<unknown>("POST", `/${this.phoneNumberId}/messages`, body);
    if (!result.ok) return result;
    return Ok(undefined);
  }

  async downloadMedia(mediaId: string): Promise<Result<Uint8Array, EidolonError>> {
    // Step 1: Get the media URL from the media ID
    const metaResult = await this.apiRequest<{ url: string }>("GET", `/${mediaId}`);
    if (!metaResult.ok) return metaResult;

    const mediaUrl = metaResult.value.url;
    if (typeof mediaUrl !== "string" || !mediaUrl.startsWith("https://")) {
      return Err(createError(ErrorCode.WHATSAPP_MEDIA_ERROR, `Invalid media URL returned for ${mediaId}`));
    }

    // Step 2: Download the actual file
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(mediaUrl, {
          headers: { Authorization: `Bearer ${this.accessToken}` },
          signal: controller.signal,
          redirect: "error",
        });

        if (!response.ok) {
          return Err(
            createError(
              ErrorCode.WHATSAPP_MEDIA_ERROR,
              `Media download failed: ${response.status} ${response.statusText}`,
            ),
          );
        }

        const contentLength = response.headers.get("content-length");
        if (contentLength !== null) {
          const size = Number(contentLength);
          if (!Number.isNaN(size) && size > MAX_DOWNLOAD_BYTES) {
            return Err(createError(ErrorCode.WHATSAPP_MEDIA_ERROR, `Media too large: ${size} bytes`));
          }
        }

        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > MAX_DOWNLOAD_BYTES) {
          return Err(createError(ErrorCode.WHATSAPP_MEDIA_ERROR, `Media too large: ${buffer.byteLength} bytes`));
        }

        return Ok(new Uint8Array(buffer));
      } finally {
        clearTimeout(timer);
      }
    } catch (cause) {
      return Err(createError(ErrorCode.WHATSAPP_MEDIA_ERROR, `Failed to download media ${mediaId}`, cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async sendMessage(body: Record<string, unknown>): Promise<Result<string, EidolonError>> {
    const result = await this.apiRequest<{ messages: Array<{ id: string }> }>(
      "POST",
      `/${this.phoneNumberId}/messages`,
      body,
    );

    if (!result.ok) return result;

    const messageId = result.value.messages?.[0]?.id;
    if (!messageId) {
      return Err(createError(ErrorCode.WHATSAPP_API_ERROR, "No message ID in API response"));
    }

    return Ok(messageId);
  }

  private async apiRequest<T>(method: string, path: string, body?: unknown): Promise<Result<T, EidolonError>> {
    let lastError: EidolonError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const result = await this.singleRequest<T>(method, path, body);

      if (result.ok) return result;

      lastError = result.error;

      // Don't retry non-transient errors
      if (!this.isTransientError(result.error)) {
        return result;
      }

      // Don't retry on last attempt
      if (attempt === MAX_RETRIES) break;

      const delayMs = INITIAL_RETRY_DELAY_MS * 2 ** attempt;
      this.logger.warn(
        "whatsapp-api",
        `API request failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delayMs}ms`,
        {
          error: result.error.message,
          path,
        },
      );
      await sleep(delayMs);
    }

    return Err(lastError ?? createError(ErrorCode.WHATSAPP_API_ERROR, "API request failed after retries"));
  }

  private async singleRequest<T>(method: string, path: string, body?: unknown): Promise<Result<T, EidolonError>> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const url = `${BASE_URL}${path}`;
        const options: RequestInit = {
          method,
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        };

        if (body && method !== "GET") {
          options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          const code = response.status === 429 ? ErrorCode.WHATSAPP_RATE_LIMITED : ErrorCode.WHATSAPP_API_ERROR;
          return Err(createError(code, `WhatsApp API ${response.status}: ${errorBody}`));
        }

        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null) {
          return Err(createError(ErrorCode.WHATSAPP_API_ERROR, "WhatsApp API returned non-object response"));
        }
        return Ok(data as T);
      } finally {
        clearTimeout(timer);
      }
    } catch (cause) {
      return Err(createError(ErrorCode.WHATSAPP_API_ERROR, "WhatsApp API request failed", cause));
    }
  }

  private isTransientError(error: EidolonError): boolean {
    if (error.code === ErrorCode.WHATSAPP_RATE_LIMITED) return true;

    // Check HTTP status code from the error message prefix "WhatsApp API NNN:"
    const statusMatch = error.message.match(/WhatsApp API (\d{3}):/);
    if (statusMatch) {
      const status = Number(statusMatch[1]);
      return status >= 500 && status <= 599;
    }

    // Network-level errors (no HTTP status) are transient
    const cause = error.cause;
    if (cause instanceof Error) {
      const name = cause.name;
      if (name === "AbortError" || name === "TypeError") return true;
      const code = (cause as unknown as Record<string, unknown>).code;
      if (typeof code === "string" && (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED")) {
        return true;
      }
    }

    return false;
  }
}

/** Promise-based sleep for retry delays. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
