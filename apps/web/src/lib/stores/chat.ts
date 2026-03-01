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
      msgs.map((msg) =>
        msg.id === assistantId
          ? { ...msg, content: response.content, streaming: false }
          : msg,
      ),
    );
  } catch (err) {
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
    msgs.map((msg) =>
      msg.id === messageId ? { ...msg, content: msg.content + chunk } : msg,
    ),
  );
}

export function clearMessages(): void {
  messagesStore.set([]);
}

/**
 * Strip internal details (file paths, stack traces) from error messages
 * shown to users. Only exposes the high-level error description.
 */
function sanitizeErrorForDisplay(err: unknown): string {
  if (!(err instanceof Error)) return "An unexpected error occurred";
  // Strip file paths (Unix and Windows) and stack traces
  const msg = err.message
    .replace(/\/[^\s:]+\.[a-z]+/gi, "[path]")
    .replace(/[A-Z]:\\[^\s:]+\.[a-z]+/gi, "[path]")
    .replace(/\n\s+at\s+.*/g, "")
    .trim();
  return msg || "An unexpected error occurred";
}

export const messages = { subscribe: messagesStore.subscribe };
export const isStreaming = { subscribe: streamingStore.subscribe };
export const messageCount = derived(messagesStore, (msgs) => msgs.length);
