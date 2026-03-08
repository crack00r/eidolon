/**
 * Chat messages store — manages conversation state and
 * communicates with the Core gateway for message exchange.
 */

import { derived, writable } from "svelte/store";
import type { GatewayClient } from "../api";
import { clientLog } from "../logger";
import { sanitizeErrorForDisplay } from "../utils";
import { getClient } from "./connection";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  streaming?: boolean;
  /** User's rating for this message (1-5), if any. */
  rating?: number;
  /** Content format hint from the backend. Markdown messages get pre-wrap styling. */
  format?: "text" | "markdown";
}

const messagesStore = writable<ChatMessage[]>([]);
const streamingStore = writable(false);

/** Maximum allowed message length from the user (100 KB, matches backend). */
const MAX_MESSAGE_LENGTH = 100_000;

/** Maximum time (ms) to wait for a push response before clearing streaming state. */
const STREAMING_TIMEOUT_MS = 120_000;

/** Active streaming timeout handle, cleared by push handler or disconnect. */
let streamingTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

function clearStreamingTimeout(): void {
  if (streamingTimeoutHandle !== null) {
    clearTimeout(streamingTimeoutHandle);
    streamingTimeoutHandle = null;
  }
}

function startStreamingTimeout(): void {
  clearStreamingTimeout();
  streamingTimeoutHandle = setTimeout(() => {
    streamingTimeoutHandle = null;
    clientLog("warn", "chat", "Streaming response timed out after 120s");
    messagesStore.update((msgs) =>
      msgs.map((msg) =>
        msg.streaming
          ? { ...msg, content: "Response timed out. Please try again.", streaming: false }
          : msg,
      ),
    );
    streamingStore.set(false);
  }, STREAMING_TIMEOUT_MS);
}

function generateId(): string {
  return `msg-${crypto.randomUUID()}`;
}

export async function sendMessage(content: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    throw new Error("Not connected to gateway");
  }

  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new Error(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
  }

  // Prevent sending while a previous response is still streaming (M-2 fix)
  let currentlyStreaming = false;
  streamingStore.subscribe((v) => (currentlyStreaming = v))();
  if (currentlyStreaming) {
    throw new Error("Please wait for the current response to finish");
  }

  const userMessage: ChatMessage = {
    id: generateId(),
    role: "user",
    content,
    timestamp: Date.now(),
  };

  messagesStore.update((msgs) => [...msgs, userMessage]);

  const assistantId = generateId();
  const assistantMessage: ChatMessage = {
    id: assistantId,
    role: "assistant",
    content: "Thinking...",
    timestamp: Date.now(),
    streaming: true,
  };

  messagesStore.update((msgs) => [...msgs, assistantMessage]);
  streamingStore.set(true);

  try {
    await client.call<{ messageId: string; status: string }>("chat.send", {
      text: content,
    });

    // The server returns { messageId, status: "queued" } -- the actual AI response
    // arrives asynchronously via push notifications (push.chatMessage).
    // Only update placeholder if it hasn't already been replaced by the push handler (M-1 fix).
    messagesStore.update((msgs) =>
      msgs.map((msg) => (msg.id === assistantId && msg.streaming ? { ...msg, content: "Thinking..." } : msg)),
    );

    // Start a timeout so the UI doesn't stay stuck on "Thinking..." forever
    startStreamingTimeout();
  } catch (err) {
    clientLog("error", "chat", "sendMessage failed", err);
    const errorMsg = sanitizeErrorForDisplay(err);
    messagesStore.update((msgs) =>
      msgs.map((msg) =>
        msg.id === assistantId
          ? {
              ...msg,
              content: `Error: ${errorMsg}`,
              streaming: false,
              role: "system" as const,
            }
          : msg,
      ),
    );
    // Only clear streaming on error -- successful sends wait for the push handler
    clearStreamingTimeout();
    streamingStore.set(false);
  }
}

/**
 * Submit a rating for an assistant message via the gateway.
 * Updates the local message state to reflect the rating.
 */
export async function rateMessage(messageId: string, rating: number): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    throw new Error("Not connected to gateway");
  }

  try {
    await client.call("feedback.submit", {
      sessionId: messageId,
      messageId,
      rating,
      channel: "desktop",
    });

    messagesStore.update((msgs) =>
      msgs.map((msg) => (msg.id === messageId ? { ...msg, rating } : msg)),
    );
  } catch (err) {
    clientLog("error", "chat", "rateMessage failed", err);
    throw err;
  }
}

/**
 * Wire up push notification handlers so assistant responses from the server
 * replace the "Thinking..." placeholder. Call once after connecting.
 * Returns an unsubscribe function.
 */
export function setupChatPushHandlers(client: GatewayClient): () => void {
  const unsubChat = client.on("push.chatMessage", (params) => {
    const text = typeof params.text === "string" ? params.text : "";
    if (!text) return;

    const id = typeof params.id === "string" ? params.id : generateId();
    const format: "text" | "markdown" =
      params.format === "markdown" ? "markdown" : "text";

    // Replace the most recent streaming assistant message, or append a new one
    messagesStore.update((msgs) => {
      const idx = msgs.findLastIndex((m) => m.role === "assistant" && m.streaming);
      if (idx !== -1) {
        const updated = [...msgs];
        updated[idx] = { ...updated[idx]!, content: text, streaming: false, id, format };
        return updated;
      }
      // No streaming placeholder found -- append as new assistant message
      return [
        ...msgs,
        {
          id,
          role: "assistant" as const,
          content: text,
          timestamp: typeof params.timestamp === "number" ? params.timestamp : Date.now(),
          streaming: false,
          format,
        },
      ];
    });
    clearStreamingTimeout();
    streamingStore.set(false);
  });

  return () => {
    unsubChat();
  };
}

export function clearMessages(): void {
  messagesStore.set([]);
}

/** Clear the streaming state (e.g., on WebSocket disconnect).
 *  Also replaces any in-flight "Thinking..." placeholders so the user
 *  sees a meaningful message instead of a stuck placeholder. */
export function clearStreamingState(): void {
  clearStreamingTimeout();
  messagesStore.update((msgs) =>
    msgs.map((msg) =>
      msg.streaming
        ? { ...msg, content: "Connection lost. Please try again.", streaming: false }
        : msg,
    ),
  );
  streamingStore.set(false);
}

export const messages = { subscribe: messagesStore.subscribe };
export const isStreaming = { subscribe: streamingStore.subscribe };
export const messageCount = derived(messagesStore, (msgs) => msgs.length);
