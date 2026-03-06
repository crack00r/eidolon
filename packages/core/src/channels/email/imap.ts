/**
 * IMAP client abstraction for polling email messages.
 *
 * Defines the IImapClient interface for testability (same pattern as IClaudeProcess).
 * Provides a BunImapClient implementation using Bun TLS sockets
 * that speaks just enough IMAP to poll for new messages.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, Ok } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImapAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
  readonly content: Uint8Array;
}

export interface ImapMessage {
  readonly uid: number;
  readonly messageId: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly date: Date;
  readonly textBody?: string;
  readonly htmlBody?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly attachments: readonly ImapAttachment[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Injectable IMAP client interface.
 * Production code uses BunImapClient; tests use FakeImapClient.
 */
export interface IImapClient {
  connect(): Promise<Result<void, EidolonError>>;
  disconnect(): Promise<void>;
  fetchNewMessages(since?: Date): Promise<Result<readonly ImapMessage[], EidolonError>>;
  markAsRead(uid: number): Promise<Result<void, EidolonError>>;
  isConnected(): boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ImapConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly user: string;
  readonly password: string;
  readonly folder: string;
}

// ---------------------------------------------------------------------------
// IMAP response parsing helpers
// ---------------------------------------------------------------------------

/** Extract the text between the first `(` and its matching `)` in an IMAP line. */
function _extractParenthesised(line: string): string | undefined {
  const start = line.indexOf("(");
  if (start === -1) return undefined;
  const end = line.lastIndexOf(")");
  if (end === -1 || end <= start) return undefined;
  return line.slice(start + 1, end);
}

/** Parse a quoted or literal IMAP string value. */
function parseImapString(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "NIL") return "";
  // Remove surrounding quotes if present
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

/** Extract a specific header value from IMAP BODY[HEADER.FIELDS ...] data. */
function extractHeader(headers: string, name: string): string | undefined {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const match = headers.match(re);
  return match ? match[1]?.trim() : undefined;
}

/** Parse a list of email addresses from a header value. */
function parseAddressList(headerValue: string | undefined): readonly string[] {
  if (!headerValue) return [];
  // Simple split on commas, extract angle-bracket addresses if present
  return headerValue.split(",").map((addr) => {
    const angle = addr.match(/<([^>]+)>/);
    return (angle?.[1] ?? addr).trim();
  });
}

/** Parse References header into individual message IDs. */
function parseReferences(headerValue: string | undefined): readonly string[] {
  if (!headerValue) return [];
  const refs = headerValue.match(/<[^>]+>/g);
  return refs ? refs.map((r) => r.slice(1, -1)) : [];
}

/**
 * Parse a FETCH response body section to extract text content.
 * Handles basic MIME boundary detection.
 */
function extractBodyText(raw: string): { text?: string; html?: string } {
  const text = raw.trim();
  if (!text) return {};

  // If it looks like HTML, return as html
  if (/<html/i.test(text) || /<body/i.test(text) || /<div/i.test(text)) {
    return { html: text };
  }
  return { text };
}

// ---------------------------------------------------------------------------
// BunImapClient
// ---------------------------------------------------------------------------

/**
 * Minimal IMAP client using Bun's TLS connect API.
 *
 * Implements just enough IMAP4rev1 commands for polling new emails:
 * LOGIN, SELECT, SEARCH UNSEEN, FETCH, STORE +FLAGS, LOGOUT.
 *
 * This is deliberately simple. For production email at scale, a full
 * IMAP library should replace this implementation.
 */
export class BunImapClient implements IImapClient {
  private readonly config: ImapConfig;
  private socket: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never;
  private connected = false;
  private tagCounter = 0;
  private buffer = "";
  private pendingResolve: ((lines: string) => void) | null = null;
  private currentTag = "";

  constructor(config: ImapConfig) {
    this.config = config;
    // socket will be assigned during connect()
    this.socket = null as unknown as typeof this.socket;
  }

  async connect(): Promise<Result<void, EidolonError>> {
    try {
      const _responseBuffer: string[] = [];
      let onGreeting: (() => void) | null = null;
      const greetingPromise = new Promise<void>((resolve) => {
        onGreeting = resolve;
      });

      const socket = await Bun.connect({
        hostname: this.config.host,
        port: this.config.port,
        tls: this.config.tls,
        socket: {
          data: (_socket, data) => {
            const text = new TextDecoder().decode(data);
            this.buffer += text;

            // Check for server greeting
            if (onGreeting && this.buffer.includes("* OK")) {
              onGreeting();
              onGreeting = null;
            }

            // Check for tagged response completion
            if (this.pendingResolve && this.currentTag) {
              const lines = this.buffer.split("\r\n");
              const taggedLine = lines.find((l) => l.startsWith(this.currentTag));
              if (taggedLine) {
                const response = this.buffer;
                this.buffer = "";
                this.pendingResolve(response);
                this.pendingResolve = null;
              }
            }
          },
          open: () => {},
          close: () => {
            this.connected = false;
          },
          error: (_socket, err) => {
            this.connected = false;
            if (this.pendingResolve) {
              this.pendingResolve(`* BAD ${String(err)}`);
              this.pendingResolve = null;
            }
          },
        },
      });

      this.socket = socket;
      await greetingPromise;

      // LOGIN
      const loginResult = await this.sendCommand(
        `LOGIN "${this.escapeImapStr(this.config.user)}" "${this.escapeImapStr(this.config.password)}"`,
      );
      if (!loginResult.includes(" OK")) {
        socket.end();
        return Err(createError("CHANNEL_AUTH_FAILED" as EidolonError["code"], `IMAP LOGIN failed: ${loginResult}`));
      }

      // SELECT folder
      const selectResult = await this.sendCommand(`SELECT "${this.escapeImapStr(this.config.folder)}"`);
      if (!selectResult.includes(" OK")) {
        socket.end();
        return Err(createError("CHANNEL_AUTH_FAILED" as EidolonError["code"], `IMAP SELECT failed: ${selectResult}`));
      }

      this.connected = true;
      return Ok(undefined);
    } catch (cause) {
      return Err(createError("CHANNEL_AUTH_FAILED" as EidolonError["code"], "IMAP connection failed", cause));
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected && this.socket) {
      try {
        await this.sendCommand("LOGOUT");
      } catch {
        // Best-effort logout
      }
      try {
        this.socket.end();
      } catch {
        // Already closed
      }
    }
    this.connected = false;
  }

  async fetchNewMessages(_since?: Date): Promise<Result<readonly ImapMessage[], EidolonError>> {
    if (!this.connected) {
      return Err(createError("CHANNEL_AUTH_FAILED" as EidolonError["code"], "IMAP not connected"));
    }

    try {
      // SEARCH for unseen messages
      const searchCmd = "SEARCH UNSEEN";
      const searchResult = await this.sendCommand(searchCmd);

      // Parse UIDs from SEARCH response: "* SEARCH 1 2 3"
      const searchLine = searchResult.split("\r\n").find((l) => l.startsWith("* SEARCH"));
      if (!searchLine || searchLine.trim() === "* SEARCH") {
        return Ok([]);
      }

      const uids = searchLine
        .replace("* SEARCH", "")
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((n) => !Number.isNaN(n) && n > 0);

      if (uids.length === 0) {
        return Ok([]);
      }

      // FETCH each message
      const messages: ImapMessage[] = [];
      for (const uid of uids) {
        const fetchResult = await this.sendCommand(
          `FETCH ${uid} (BODY[HEADER.FIELDS (From To Subject Date Message-ID In-Reply-To References)] BODY[TEXT])`,
        );

        const msg = this.parseFetchResponse(uid, fetchResult);
        if (msg) {
          messages.push(msg);
        }
      }

      return Ok(messages);
    } catch (cause) {
      return Err(createError("CHANNEL_AUTH_FAILED" as EidolonError["code"], "IMAP fetch failed", cause));
    }
  }

  async markAsRead(uid: number): Promise<Result<void, EidolonError>> {
    if (!this.connected) {
      return Err(createError("CHANNEL_AUTH_FAILED" as EidolonError["code"], "IMAP not connected"));
    }

    try {
      const result = await this.sendCommand(`STORE ${uid} +FLAGS (\\Seen)`);
      if (!result.includes(" OK")) {
        return Err(createError("CHANNEL_AUTH_FAILED" as EidolonError["code"], `IMAP STORE failed: ${result}`));
      }
      return Ok(undefined);
    } catch (cause) {
      return Err(createError("CHANNEL_AUTH_FAILED" as EidolonError["code"], "IMAP STORE failed", cause));
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private nextTag(): string {
    this.tagCounter++;
    return `A${String(this.tagCounter).padStart(4, "0")}`;
  }

  private escapeImapStr(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  private async sendCommand(command: string): Promise<string> {
    const tag = this.nextTag();
    this.currentTag = tag;
    this.buffer = "";

    return new Promise<string>((resolve) => {
      this.pendingResolve = resolve;
      const line = `${tag} ${command}\r\n`;
      this.socket.write(new TextEncoder().encode(line));

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingResolve === resolve) {
          this.pendingResolve = null;
          resolve(`${tag} BAD Timeout`);
        }
      }, 30_000);
    });
  }

  private parseFetchResponse(uid: number, raw: string): ImapMessage | null {
    try {
      // Extract headers section
      const headers = raw;
      const from = extractHeader(headers, "From") ?? "";
      const to = parseAddressList(extractHeader(headers, "To"));
      const subject = parseImapString(extractHeader(headers, "Subject") ?? "");
      const dateStr = extractHeader(headers, "Date");
      const messageId = (extractHeader(headers, "Message-ID") ?? "").replace(/[<>]/g, "");
      const inReplyTo = extractHeader(headers, "In-Reply-To")?.replace(/[<>]/g, "");
      const referencesRaw = extractHeader(headers, "References");
      const references = parseReferences(referencesRaw);

      // Extract body text (crude — looks for text after the headers block)
      const bodyParts = extractBodyText(raw);

      const date = dateStr ? new Date(dateStr) : new Date();

      // Extract sender email from From header
      const fromEmail = parseAddressList(from)[0] ?? from;

      return {
        uid,
        messageId: messageId || `uid-${uid}`,
        from: fromEmail,
        to,
        subject,
        date: Number.isNaN(date.getTime()) ? new Date() : date,
        textBody: bodyParts.text,
        htmlBody: bodyParts.html,
        inReplyTo,
        references: references.length > 0 ? references : undefined,
        attachments: [], // Basic impl does not parse MIME attachments
      };
    } catch {
      return null;
    }
  }
}
