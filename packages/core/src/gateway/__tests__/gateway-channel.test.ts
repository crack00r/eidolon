/**
 * Tests for GatewayChannel -- bridges MessageRouter to Gateway WebSocket.
 */

import { describe, expect, test } from "bun:test";
import type { GatewayPushEvent } from "@eidolon/protocol";
import { GatewayChannel } from "../gateway-channel.ts";
import type { GatewayServer } from "../server.ts";

/** Minimal mock of GatewayServer that captures broadcast calls. */
function createMockGatewayServer(): GatewayServer & { broadcasts: GatewayPushEvent[] } {
  const broadcasts: GatewayPushEvent[] = [];
  return {
    broadcasts,
    broadcast(event: GatewayPushEvent): void {
      broadcasts.push(event);
    },
  } as unknown as GatewayServer & { broadcasts: GatewayPushEvent[] };
}

describe("GatewayChannel", () => {
  test("has correct id and name", () => {
    const channel = new GatewayChannel();
    expect(channel.id).toBe("gateway");
    expect(channel.name).toBe("Gateway WebSocket");
  });

  test("capabilities include text, markdown, and streaming", () => {
    const channel = new GatewayChannel();
    expect(channel.capabilities.text).toBe(true);
    expect(channel.capabilities.markdown).toBe(true);
    expect(channel.capabilities.streaming).toBe(true);
    expect(channel.capabilities.images).toBe(false);
    expect(channel.capabilities.voice).toBe(false);
  });

  test("connect sets connected state", async () => {
    const channel = new GatewayChannel();
    expect(channel.isConnected()).toBe(false);

    const result = await channel.connect();
    expect(result.ok).toBe(true);
    expect(channel.isConnected()).toBe(true);
  });

  test("disconnect clears connected state", async () => {
    const channel = new GatewayChannel();
    await channel.connect();
    expect(channel.isConnected()).toBe(true);

    await channel.disconnect();
    expect(channel.isConnected()).toBe(false);
  });

  test("setServer marks channel as connected", () => {
    const channel = new GatewayChannel();
    const server = createMockGatewayServer();

    expect(channel.isConnected()).toBe(false);
    channel.setServer(server);
    expect(channel.isConnected()).toBe(true);
  });

  test("send broadcasts push.chatMessage to server", async () => {
    const channel = new GatewayChannel();
    const server = createMockGatewayServer();
    channel.setServer(server);

    const result = await channel.send({
      id: "msg-1",
      channelId: "gateway",
      text: "Hello, world!",
      format: "markdown",
      replyToId: "orig-1",
    });

    expect(result.ok).toBe(true);
    expect(server.broadcasts).toHaveLength(1);

    const event = server.broadcasts[0]!;
    expect(event.jsonrpc).toBe("2.0");
    expect(event.method).toBe("push.chatMessage");
    expect(event.params.id).toBe("msg-1");
    expect(event.params.text).toBe("Hello, world!");
    expect(event.params.format).toBe("markdown");
    expect(event.params.replyToId).toBe("orig-1");
    expect(typeof event.params.timestamp).toBe("number");
  });

  test("send defaults format to text when not specified", async () => {
    const channel = new GatewayChannel();
    const server = createMockGatewayServer();
    channel.setServer(server);

    await channel.send({
      id: "msg-2",
      channelId: "gateway",
      text: "Plain text message",
    });

    const event = server.broadcasts[0]!;
    expect(event.params.format).toBe("text");
  });

  test("send returns Ok when no server is attached", async () => {
    const channel = new GatewayChannel();
    // No server set -- should silently succeed

    const result = await channel.send({
      id: "msg-3",
      channelId: "gateway",
      text: "Dropped message",
    });

    expect(result.ok).toBe(true);
  });

  test("onMessage is a no-op", () => {
    const channel = new GatewayChannel();
    // Should not throw
    channel.onMessage(async () => {});
  });
});
