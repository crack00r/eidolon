/**
 * Conversation store -- manages multiple conversations with persistence.
 *
 * Conversations and their messages are stored in localStorage so they
 * survive app restarts. Each conversation has a unique ID, title, and
 * ordered list of messages.
 */

import { derived, get, writable } from "svelte/store";
import type { ChatMessage } from "./chat";
import { clientLog } from "../logger";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Conversation {
  readonly id: string;
  title: string;
  readonly createdAt: number;
  updatedAt: number;
  /** Preview text from the last message. */
  preview: string;
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONVERSATIONS_KEY = "eidolon-conversations";
const MESSAGES_PREFIX = "eidolon-conv-msgs-";
const ACTIVE_CONV_KEY = "eidolon-active-conversation";
/** Maximum number of conversations to keep. Oldest are pruned when exceeded. */
const MAX_CONVERSATIONS = 200;
/** Maximum message content length to store in preview. */
const MAX_PREVIEW_LENGTH = 120;
/** Maximum title auto-generation length. */
const MAX_TITLE_LENGTH = 60;

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function loadConversations(): Conversation[] {
  try {
    const stored = localStorage.getItem(CONVERSATIONS_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidConversation);
  } catch (err) {
    clientLog("warn", "conversations", "Failed to load conversations", err);
    return [];
  }
}

function saveConversations(conversations: Conversation[]): void {
  try {
    localStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversations));
  } catch (err) {
    clientLog("warn", "conversations", "Failed to save conversations", err);
  }
}

function loadMessages(conversationId: string): ChatMessage[] {
  try {
    const stored = localStorage.getItem(MESSAGES_PREFIX + conversationId);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidMessage);
  } catch (err) {
    clientLog("warn", "conversations", `Failed to load messages for ${conversationId}`, err);
    return [];
  }
}

function saveMessages(conversationId: string, messages: ChatMessage[]): void {
  try {
    localStorage.setItem(MESSAGES_PREFIX + conversationId, JSON.stringify(messages));
  } catch (err) {
    clientLog("warn", "conversations", `Failed to save messages for ${conversationId}`, err);
  }
}

function loadActiveConversationId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CONV_KEY);
  } catch {
    return null;
  }
}

function saveActiveConversationId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_CONV_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_CONV_KEY);
    }
  } catch (err) {
    clientLog("warn", "conversations", "Failed to save active conversation ID", err);
  }
}

// ---------------------------------------------------------------------------
// Validation guards
// ---------------------------------------------------------------------------

function isValidConversation(obj: unknown): obj is Conversation {
  if (typeof obj !== "object" || obj === null) return false;
  const c = obj as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.title === "string" &&
    typeof c.createdAt === "number" &&
    typeof c.updatedAt === "number" &&
    typeof c.preview === "string" &&
    typeof c.messageCount === "number"
  );
}

function isValidMessage(obj: unknown): obj is ChatMessage {
  if (typeof obj !== "object" || obj === null) return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.id === "string" &&
    (m.role === "user" || m.role === "assistant" || m.role === "system") &&
    typeof m.content === "string" &&
    typeof m.timestamp === "number"
  );
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const conversationsStore = writable<Conversation[]>(loadConversations());
const activeConversationIdStore = writable<string | null>(loadActiveConversationId());

function generateId(): string {
  return `conv-${crypto.randomUUID()}`;
}

function generateTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim();
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_TITLE_LENGTH - 3) + "...";
}

function generatePreview(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_PREVIEW_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_PREVIEW_LENGTH - 3) + "...";
}

/** Create a new conversation and set it as active. Returns the new ID. */
export function createConversation(): string {
  const id = generateId();
  const now = Date.now();
  const conversation: Conversation = {
    id,
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    preview: "",
    messageCount: 0,
  };

  conversationsStore.update((convs) => {
    const updated = [conversation, ...convs];
    // Prune oldest conversations if over limit
    if (updated.length > MAX_CONVERSATIONS) {
      const removed = updated.splice(MAX_CONVERSATIONS);
      // Clean up messages for pruned conversations
      for (const conv of removed) {
        try {
          localStorage.removeItem(MESSAGES_PREFIX + conv.id);
        } catch { /* best effort */ }
      }
    }
    saveConversations(updated);
    return updated;
  });

  activeConversationIdStore.set(id);
  saveActiveConversationId(id);

  return id;
}

/** Switch to an existing conversation by ID. */
export function switchConversation(id: string): void {
  const convs = get(conversationsStore);
  if (!convs.some((c) => c.id === id)) return;
  activeConversationIdStore.set(id);
  saveActiveConversationId(id);
}

/** Delete a conversation and its messages. */
export function deleteConversation(id: string): void {
  conversationsStore.update((convs) => {
    const updated = convs.filter((c) => c.id !== id);
    saveConversations(updated);
    return updated;
  });

  try {
    localStorage.removeItem(MESSAGES_PREFIX + id);
  } catch { /* best effort */ }

  // If this was the active conversation, switch to the most recent or null
  const currentActive = get(activeConversationIdStore);
  if (currentActive === id) {
    const convs = get(conversationsStore);
    const nextId = convs.length > 0 ? convs[0]!.id : null;
    activeConversationIdStore.set(nextId);
    saveActiveConversationId(nextId);
  }
}

/** Get messages for the active conversation. */
export function getActiveMessages(): ChatMessage[] {
  const activeId = get(activeConversationIdStore);
  if (!activeId) return [];
  return loadMessages(activeId);
}

/** Add a message to the active conversation and persist it. */
export function persistMessage(message: ChatMessage): void {
  const activeId = get(activeConversationIdStore);
  if (!activeId) return;

  const messages = loadMessages(activeId);
  messages.push(message);
  saveMessages(activeId, messages);

  // Update conversation metadata
  conversationsStore.update((convs) => {
    const updated = convs.map((c) => {
      if (c.id !== activeId) return c;
      const title = c.messageCount === 0 && message.role === "user"
        ? generateTitle(message.content)
        : c.title;
      return {
        ...c,
        title,
        updatedAt: Date.now(),
        preview: generatePreview(message.content),
        messageCount: c.messageCount + 1,
      };
    });
    saveConversations(updated);
    return updated;
  });
}

/** Update the last message matching predicate. Returns true if a match was found. */
export function updateLastMessage(predicate: (msg: ChatMessage) => boolean, update: Partial<ChatMessage>): boolean {
  const activeId = get(activeConversationIdStore);
  if (!activeId) return false;

  const messages = loadMessages(activeId);
  const idx = messages.findLastIndex(predicate);
  if (idx === -1) return false;

  const existing = messages[idx]!;
  messages[idx] = { ...existing, ...update };
  saveMessages(activeId, messages);

  // Update preview if content changed
  if (update.content) {
    conversationsStore.update((convs) => {
      const updated = convs.map((c) =>
        c.id === activeId
          ? { ...c, updatedAt: Date.now(), preview: generatePreview(update.content!) }
          : c,
      );
      saveConversations(updated);
      return updated;
    });
  }

  return true;
}

/** Clear all messages in the active conversation. */
export function clearActiveMessages(): void {
  const activeId = get(activeConversationIdStore);
  if (!activeId) return;

  saveMessages(activeId, []);

  conversationsStore.update((convs) => {
    const updated = convs.map((c) =>
      c.id === activeId
        ? { ...c, updatedAt: Date.now(), preview: "", messageCount: 0 }
        : c,
    );
    saveConversations(updated);
    return updated;
  });
}

/** Ensure there is at least one conversation. Creates one if none exist. */
export function ensureConversation(): string {
  const convs = get(conversationsStore);
  const activeId = get(activeConversationIdStore);

  if (convs.length === 0 || !activeId) {
    return createConversation();
  }

  // Make sure active ID still points to a valid conversation
  if (!convs.some((c) => c.id === activeId)) {
    activeConversationIdStore.set(convs[0]!.id);
    saveActiveConversationId(convs[0]!.id);
    return convs[0]!.id;
  }

  return activeId;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const conversations = { subscribe: conversationsStore.subscribe };
export const activeConversationId = { subscribe: activeConversationIdStore.subscribe };

export const activeConversation = derived(
  [conversationsStore, activeConversationIdStore],
  ([convs, activeId]) => convs.find((c) => c.id === activeId) ?? null,
);

export const conversationCount = derived(
  conversationsStore,
  (convs) => convs.length,
);
