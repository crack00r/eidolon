/**
 * Chat messages store — manages conversation state and
 * communicates with the Core gateway for message exchange.
 */

import { writable, derived } from "svelte/store";
import { getClient } from "./connection";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  streaming?: boolean;
}

const messagesStore = writable<ChatMessage[]>([]);
const streamingStore = writable(false);

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function sendMessage(content: string): Promise<void> {
  const client = getClient();
  if (!client || client.state !== "connected") {
    throw new Error("Not connected to gateway");
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
      msgs.map((msg) =>
        msg.id === assistantId
          ? { ...msg, content: response.content, streaming: false }
          : msg,
      ),
    );
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
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
    msgs.map((msg) =>
      msg.id === messageId ? { ...msg, content: msg.content + chunk } : msg,
    ),
  );
}

export function clearMessages(): void {
  messagesStore.set([]);
}

export const messages = { subscribe: messagesStore.subscribe };
export const isStreaming = { subscribe: streamingStore.subscribe };
export const messageCount = derived(messagesStore, (msgs) => msgs.length);
