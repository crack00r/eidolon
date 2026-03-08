/**
 * GatewayChannel -- bridges MessageRouter to Gateway WebSocket clients.
 * Registers as channel ID "gateway" so outbound messages from the CognitiveLoop
 * reach connected desktop/web clients via push notifications.
 */

import type {
  Channel,
  ChannelCapabilities,
  EidolonError,
  InboundMessage,
  OutboundMessage,
  Result,
} from "@eidolon/protocol";
import { Ok } from "@eidolon/protocol";
import type { GatewayServer } from "./server.ts";

export class GatewayChannel implements Channel {
  readonly id = "gateway";
  readonly name = "Gateway WebSocket";
  readonly capabilities: ChannelCapabilities = {
    text: true,
    markdown: true,
    images: false,
    documents: false,
    voice: false,
    reactions: false,
    editing: false,
    streaming: true,
  };

  private server: GatewayServer | null = null;
  private connected = false;

  /** Attach the gateway server instance for broadcasting. */
  setServer(server: GatewayServer): void {
    this.server = server;
    this.connected = true;
  }

  async connect(): Promise<Result<void, EidolonError>> {
    this.connected = true;
    return Ok(undefined);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(message: OutboundMessage): Promise<Result<void, EidolonError>> {
    if (!this.server) {
      // Silently drop if no server attached yet
      return Ok(undefined);
    }

    const pushEvent = {
      jsonrpc: "2.0" as const,
      method: "push.chatMessage" as const,
      params: {
        id: message.id,
        text: message.text,
        format: message.format ?? "text",
        replyToId: message.replyToId,
        timestamp: Date.now(),
      },
    };

    // Try to send to the specific client that originated the message.
    // The userId from the inbound event matches the gateway client ID.
    const targetClientId = message.userId;
    if (targetClientId) {
      this.server.sendTo(targetClientId, pushEvent);
    } else {
      // Fallback: broadcast to all connected clients
      this.server.broadcast(pushEvent);
    }

    return Ok(undefined);
  }

  onMessage(_handler: (message: InboundMessage) => Promise<void>): void {
    // Inbound messages arrive through the RPC handler (chat.send), not this channel
  }

  isConnected(): boolean {
    return this.connected;
  }
}
