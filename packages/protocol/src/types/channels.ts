/**
 * Channel interface for multi-platform communication (Telegram, Gateway, etc.).
 */

import type { EidolonError } from "../errors.ts";
import type { Result } from "../result.ts";
import type { InboundMessage, OutboundMessage } from "./messages.ts";

export interface ChannelCapabilities {
  readonly text: boolean;
  readonly markdown: boolean;
  readonly images: boolean;
  readonly documents: boolean;
  readonly voice: boolean;
  readonly reactions: boolean;
  readonly editing: boolean;
  readonly streaming: boolean;
}

export interface Channel {
  readonly id: string;
  readonly name: string;
  readonly capabilities: ChannelCapabilities;
  connect(): Promise<Result<void, EidolonError>>;
  disconnect(): Promise<void>;
  send(message: OutboundMessage): Promise<Result<void, EidolonError>>;
  onMessage(handler: (message: InboundMessage) => Promise<void>): void;
  isConnected(): boolean;
}
