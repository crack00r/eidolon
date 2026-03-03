/**
 * Chat messages store — manages conversation state and
 * communicates with the Core gateway for message exchange.
 */

import { derived, writable } from "svelte/store";
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
}

const messagesStore = writable<ChatMessage[]>([]);
const streamingStore = writable(false);

/** Maximum allowed message length from the user (50 KB). */
const MAX_MESSAGE_LENGTH = 50_000;

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
    content: "",
    timestamp: Date.now(),
    streaming: true,
  };

  messagesStore.update((msgs) => [...msgs, assistantMessage]);
  streamingStore.set(true);

  try {
    const response = await client.call<{ content: string }>("chat.send", {
      message: content,
    });

    messagesStore.update((msgs) =>
      msgs.map((msg) => (msg.id === assistantId ? { ...msg, content: response.content, streaming: false } : msg)),
    );
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
  } finally {
    streamingStore.set(false);
  }
}

export function appendStreamChunk(messageId: string, chunk: string): void {
  messagesStore.update((msgs) =>
    msgs.map((msg) => (msg.id === messageId ? { ...msg, content: msg.content + chunk } : msg)),
  );
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

export function clearMessages(): void {
  messagesStore.set([]);
}

export const messages = { subscribe: messagesStore.subscribe };
export const isStreaming = { subscribe: streamingStore.subscribe };
export const messageCount = derived(messagesStore, (msgs) => msgs.length);
