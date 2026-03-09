/**
 * ConversationSessionStore -- manages parallel conversation sessions.
 *
 * Maps conversation IDs to Claude CLI session IDs, allowing multiple
 * concurrent conversations with independent context. Persists conversation
 * metadata and message history in the operational database.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly claudeSessionId: string | null;
  readonly channelId: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly messageCount: number;
}

export interface ConversationMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: number;
}

interface ConversationRow {
  id: string;
  title: string;
  claude_session_id: string | null;
  channel_id: string;
  user_id: string;
  created_at: number;
  updated_at: number;
  message_count: number;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: number;
}

/** Maximum title length for a conversation. */
const MAX_TITLE_LENGTH = 500;

/** Maximum content length for a single message. */
const MAX_MESSAGE_CONTENT_LENGTH = 500_000;

/** Default list limit. */
const DEFAULT_LIST_LIMIT = 50;

/** Max list limit. */
const MAX_LIST_LIMIT = 200;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class ConversationSessionStore {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger.child("conversation-store");
  }

  /**
   * Create a new conversation.
   */
  create(params: {
    readonly title?: string;
    readonly channelId: string;
    readonly userId: string;
  }): Result<Conversation, EidolonError> {
    try {
      const id = randomUUID();
      const now = Date.now();
      const title = (params.title ?? "New Conversation").slice(0, MAX_TITLE_LENGTH);

      this.db
        .query(
          `INSERT INTO conversations (id, title, claude_session_id, channel_id, user_id, created_at, updated_at, message_count)
           VALUES (?, ?, NULL, ?, ?, ?, ?, 0)`,
        )
        .run(id, title, params.channelId, params.userId, now, now);

      const conversation: Conversation = {
        id,
        title,
        claudeSessionId: null,
        channelId: params.channelId,
        userId: params.userId,
        createdAt: now,
        updatedAt: now,
        messageCount: 0,
      };

      this.logger.debug("create", `Created conversation ${id}`, { title });
      return Ok(conversation);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to create conversation", cause));
    }
  }

  /**
   * Get a conversation by ID.
   */
  get(id: string): Result<Conversation | null, EidolonError> {
    try {
      const row = this.db.query("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationRow | null;
      return Ok(row ? rowToConversation(row) : null);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to get conversation ${id}`, cause));
    }
  }

  /**
   * List conversations, ordered by most recently updated.
   */
  list(options?: {
    readonly limit?: number;
    readonly offset?: number;
    readonly userId?: string;
    readonly channelId?: string;
  }): Result<Conversation[], EidolonError> {
    try {
      const limit = Math.max(1, Math.min(options?.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));
      const offset = Math.max(0, options?.offset ?? 0);
      const whereClauses: string[] = [];
      const params: Array<string | number> = [];

      if (options?.userId) {
        whereClauses.push("user_id = ?");
        params.push(options.userId);
      }
      if (options?.channelId) {
        whereClauses.push("channel_id = ?");
        params.push(options.channelId);
      }

      const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
      const sql = `SELECT * FROM conversations ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const rows = this.db.query(sql).all(...params) as ConversationRow[];
      return Ok(rows.map(rowToConversation));
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to list conversations", cause));
    }
  }

  /**
   * Set the Claude CLI session ID for a conversation (for --resume).
   */
  setClaudeSessionId(conversationId: string, claudeSessionId: string): Result<void, EidolonError> {
    try {
      this.db
        .query("UPDATE conversations SET claude_session_id = ?, updated_at = ? WHERE id = ?")
        .run(claudeSessionId, Date.now(), conversationId);
      return Ok(undefined);
    } catch (cause) {
      return Err(
        createError(ErrorCode.DB_QUERY_FAILED, `Failed to set claude session ID for ${conversationId}`, cause),
      );
    }
  }

  /**
   * Update conversation title.
   */
  updateTitle(conversationId: string, title: string): Result<void, EidolonError> {
    try {
      const safeTitle = title.slice(0, MAX_TITLE_LENGTH);
      this.db
        .query("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
        .run(safeTitle, Date.now(), conversationId);
      return Ok(undefined);
    } catch (cause) {
      return Err(
        createError(ErrorCode.DB_QUERY_FAILED, `Failed to update conversation title for ${conversationId}`, cause),
      );
    }
  }

  /**
   * Add a message to a conversation and update message count + timestamp.
   */
  addMessage(params: {
    readonly conversationId: string;
    readonly role: "user" | "assistant";
    readonly content: string;
  }): Result<ConversationMessage, EidolonError> {
    if (params.content.length > MAX_MESSAGE_CONTENT_LENGTH) {
      return Err(
        createError(ErrorCode.INVALID_INPUT, `Message content exceeds maximum length (${MAX_MESSAGE_CONTENT_LENGTH})`),
      );
    }
    try {
      const id = randomUUID();
      const now = Date.now();

      const txn = this.db.transaction(() => {
        this.db
          .query(
            `INSERT INTO conversation_messages (id, conversation_id, role, content, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, params.conversationId, params.role, params.content, now);

        this.db
          .query("UPDATE conversations SET message_count = message_count + 1, updated_at = ? WHERE id = ?")
          .run(now, params.conversationId);
      });
      txn();

      const message: ConversationMessage = {
        id,
        conversationId: params.conversationId,
        role: params.role,
        content: params.content,
        createdAt: now,
      };

      return Ok(message);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, "Failed to add conversation message", cause));
    }
  }

  /**
   * Get messages for a conversation, ordered by creation time.
   */
  getMessages(
    conversationId: string,
    options?: { readonly limit?: number; readonly offset?: number },
  ): Result<ConversationMessage[], EidolonError> {
    try {
      const limit = Math.max(1, Math.min(options?.limit ?? 100, 500));
      const offset = Math.max(0, options?.offset ?? 0);

      const rows = this.db
        .query("SELECT * FROM conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?")
        .all(conversationId, limit, offset) as MessageRow[];

      return Ok(rows.map(rowToMessage));
    } catch (cause) {
      return Err(
        createError(ErrorCode.DB_QUERY_FAILED, `Failed to get messages for conversation ${conversationId}`, cause),
      );
    }
  }

  /**
   * Delete a conversation and all its messages.
   */
  delete(conversationId: string): Result<void, EidolonError> {
    try {
      const txn = this.db.transaction(() => {
        this.db.query("DELETE FROM conversation_messages WHERE conversation_id = ?").run(conversationId);
        this.db.query("DELETE FROM conversations WHERE id = ?").run(conversationId);
      });
      txn();

      this.logger.debug("delete", `Deleted conversation ${conversationId}`);
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Failed to delete conversation ${conversationId}`, cause));
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    claudeSessionId: row.claude_session_id,
    channelId: row.channel_id,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
  };
}

function rowToMessage(row: MessageRow): ConversationMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    createdAt: row.created_at,
  };
}
