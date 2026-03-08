/**
 * Message types for inbound/outbound communication across channels.
 */

export interface MessageAttachment {
  readonly type: "image" | "document" | "audio" | "voice" | "video";
  readonly url?: string;
  readonly data?: Uint8Array;
  readonly mimeType: string;
  readonly filename?: string;
  readonly size?: number;
}

export interface InboundMessage {
  readonly id: string;
  readonly channelId: string;
  readonly userId: string;
  readonly text?: string;
  readonly attachments?: readonly MessageAttachment[];
  readonly replyToId?: string;
  readonly timestamp: number;
}

export interface OutboundMessage {
  readonly id: string;
  readonly channelId: string;
  readonly text: string;
  readonly format?: "text" | "markdown" | "html";
  readonly replyToId?: string;
  readonly attachments?: readonly MessageAttachment[];
  /** Target client ID for directed delivery (e.g., gateway client that sent the original message). */
  readonly userId?: string;
}
