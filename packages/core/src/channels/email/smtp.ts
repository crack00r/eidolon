/**
 * SMTP client abstraction for sending email messages.
 *
 * Defines the ISmtpClient interface for testability and provides a
 * BunSmtpClient implementation using Bun TLS sockets that speaks
 * just enough SMTP to send emails with threading headers.
 */

import { randomUUID } from "node:crypto";
import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmtpAttachment {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: Uint8Array;
}

export interface SmtpMessage {
  readonly to: readonly string[];
  readonly subject: string;
  readonly textBody: string;
  readonly htmlBody?: string;
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  readonly attachments?: readonly SmtpAttachment[];
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Injectable SMTP client interface.
 * Production code uses BunSmtpClient; tests use FakeSmtpClient.
 */
export interface ISmtpClient {
  connect(): Promise<Result<void, EidolonError>>;
  disconnect(): Promise<void>;
  send(message: SmtpMessage): Promise<Result<string, EidolonError>>;
  isConnected(): boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly user: string;
  readonly password: string;
  readonly from: string;
}

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

const BOUNDARY_PREFIX = "----eidolon-boundary-";
const CRLF = "\r\n";

/** Generate a unique MIME boundary string. */
function generateBoundary(): string {
  return `${BOUNDARY_PREFIX}${randomUUID().replace(/-/g, "")}`;
}

/** Base64-encode a Uint8Array for MIME transfer encoding. */
function base64Encode(data: Uint8Array): string {
  // Use Buffer for base64 encoding (available in Bun)
  return Buffer.from(data).toString("base64");
}

/** Fold a base64 string into 76-character lines per RFC 2045. */
function foldBase64(encoded: string): string {
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  return lines.join(CRLF);
}

/** Strip CR and LF characters from SMTP header values to prevent header injection. */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]/g, "");
}

/** Strip characters that could cause SMTP command injection from email addresses. */
function sanitizeSmtpAddress(address: string): string {
  return address.replace(/[\r\n<>]/g, "");
}

/** Sanitize an attachment filename to prevent MIME header injection. */
function sanitizeFilename(filename: string): string {
  // Strip CRLF, quotes, backslashes, path separators, and control characters
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization
  return filename.replace(/[\r\n"\\/:*?<>|\x00-\x1f\x7f]/g, "_");
}

/** Sanitize a MIME type string to prevent header injection. */
function sanitizeMimeType(mimeType: string): string {
  // Strip CRLF, quotes, backslashes, and control characters
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization
  return mimeType.replace(/[\r\n"\\;\x00-\x1f\x7f]/g, "").trim() || "application/octet-stream";
}

/** Build a complete MIME message string. */
export function buildMimeMessage(
  from: string,
  to: readonly string[],
  subject: string,
  textBody: string,
  htmlBody?: string,
  inReplyTo?: string,
  references?: readonly string[],
  attachments?: readonly SmtpAttachment[],
): { messageId: string; raw: string } {
  const messageId = `${randomUUID()}@eidolon`;
  const date = new Date().toUTCString();
  const hasAttachments = attachments && attachments.length > 0;
  const hasHtml = htmlBody !== undefined && htmlBody.length > 0;
  const isMultipart = hasAttachments || hasHtml;

  const headers: string[] = [
    `From: ${sanitizeHeaderValue(from)}`,
    `To: ${sanitizeHeaderValue(to.join(", "))}`,
    `Subject: ${sanitizeHeaderValue(subject)}`,
    `Date: ${date}`,
    `Message-ID: <${messageId}>`,
    "MIME-Version: 1.0",
  ];

  if (inReplyTo) {
    headers.push(`In-Reply-To: <${sanitizeHeaderValue(inReplyTo)}>`);
  }

  if (references && references.length > 0) {
    const refs = references.map((r) => `<${sanitizeHeaderValue(r)}>`).join(" ");
    headers.push(`References: ${refs}`);
  }

  let body: string;

  if (!isMultipart) {
    // Simple text-only message
    headers.push("Content-Type: text/plain; charset=utf-8");
    headers.push("Content-Transfer-Encoding: 8bit");
    body = textBody;
  } else if (hasAttachments) {
    // Mixed: text (+ optional html) + attachments
    const mixedBoundary = generateBoundary();
    headers.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

    const parts: string[] = [];

    if (hasHtml) {
      // Alternative sub-part for text + html
      const altBoundary = generateBoundary();
      parts.push(
        `--${mixedBoundary}${CRLF}Content-Type: multipart/alternative; boundary="${altBoundary}"${CRLF}`,
        `--${altBoundary}${CRLF}Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${textBody}${CRLF}`,
        `--${altBoundary}${CRLF}Content-Type: text/html; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${htmlBody}${CRLF}`,
        `--${altBoundary}--${CRLF}`,
      );
    } else {
      parts.push(
        `--${mixedBoundary}${CRLF}Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${textBody}${CRLF}`,
      );
    }

    for (const att of attachments ?? []) {
      const encoded = foldBase64(base64Encode(att.content));
      const safeName = sanitizeFilename(att.filename);
      const safeType = sanitizeMimeType(att.mimeType);
      parts.push(
        `--${mixedBoundary}${CRLF}Content-Type: ${safeType}; name="${safeName}"${CRLF}Content-Disposition: attachment; filename="${safeName}"${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}${encoded}${CRLF}`,
      );
    }

    parts.push(`--${mixedBoundary}--`);
    body = parts.join("");
  } else {
    // Alternative: text + html, no attachments
    const altBoundary = generateBoundary();
    headers.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);

    body = [
      `--${altBoundary}${CRLF}Content-Type: text/plain; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${textBody}${CRLF}`,
      `--${altBoundary}${CRLF}Content-Type: text/html; charset=utf-8${CRLF}Content-Transfer-Encoding: 8bit${CRLF}${CRLF}${htmlBody}${CRLF}`,
      `--${altBoundary}--`,
    ].join("");
  }

  const raw = `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
  return { messageId, raw };
}

// ---------------------------------------------------------------------------
// BunSmtpClient
// ---------------------------------------------------------------------------

/**
 * Minimal SMTP client using Bun's TLS connect API.
 *
 * Implements EHLO, AUTH PLAIN, MAIL FROM, RCPT TO, DATA, QUIT.
 * Uses STARTTLS when port is 587, direct TLS when port is 465.
 */
const MAX_SMTP_BUFFER_SIZE = 10 * 1024 * 1024; // 10 MB

export class BunSmtpClient implements ISmtpClient {
  private readonly config: SmtpConfig;
  private socket: (ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never) | null = null;
  private connected = false;
  private buffer = "";
  private pendingResolve: ((data: string) => void) | null = null;

  constructor(config: SmtpConfig) {
    this.config = config;
  }

  async connect(): Promise<Result<void, EidolonError>> {
    try {
      if (!this.config.tls) {
        console.warn("[SMTP] SECURITY WARNING: Connecting without TLS. Credentials will be sent in plaintext.");
      }

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

            if (this.buffer.length > MAX_SMTP_BUFFER_SIZE) {
              this.buffer = "";
              this.connected = false;
              if (this.pendingResolve) {
                this.pendingResolve("500 Buffer overflow: exceeded 10MB limit");
                this.pendingResolve = null;
              }
              try {
                _socket.end();
              } catch {
                /* best-effort */
              }
              return;
            }

            // SMTP greeting: "220 ..."
            if (onGreeting && this.buffer.includes("220 ")) {
              onGreeting();
              onGreeting = null;
            }

            // Check for complete response (line ending with space after code)
            if (this.pendingResolve) {
              const lines = this.buffer.split("\r\n");
              // A final SMTP response line has format "NNN text" (space, not hyphen)
              const finalLine = lines.find((l) => /^\d{3} /.test(l));
              if (finalLine) {
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
              this.pendingResolve(`500 ${String(err)}`);
              this.pendingResolve = null;
            }
          },
        },
      });

      this.socket = socket;
      let greetingTimer: ReturnType<typeof setTimeout> | undefined;
      const greetingTimeout = new Promise<never>((_resolve, reject) => {
        greetingTimer = setTimeout(() => {
          try {
            socket.end();
          } catch {
            /* best-effort */
          }
          reject(new Error("SMTP greeting timeout after 30 seconds"));
        }, 30_000);
        greetingTimer.unref();
      });
      try {
        await Promise.race([greetingPromise, greetingTimeout]);
      } finally {
        if (greetingTimer !== undefined) clearTimeout(greetingTimer);
      }

      // EHLO
      const ehloResp = await this.sendLine(`EHLO eidolon`);
      if (!ehloResp.startsWith("250")) {
        socket.end();
        return Err(createError(ErrorCode.EMAIL_AUTH_ERROR, `SMTP EHLO failed: ${ehloResp}`));
      }

      // AUTH PLAIN
      const credentials = Buffer.from(`\0${this.config.user}\0${this.config.password}`).toString("base64");
      const authResp = await this.sendLine(`AUTH PLAIN ${credentials}`);
      if (!authResp.startsWith("235")) {
        socket.end();
        return Err(createError(ErrorCode.EMAIL_AUTH_ERROR, "SMTP authentication failed"));
      }

      this.connected = true;
      return Ok(undefined);
    } catch (cause) {
      return Err(createError(ErrorCode.EMAIL_AUTH_ERROR, "SMTP connection failed", cause));
    }
  }

  async disconnect(): Promise<void> {
    if (this.connected && this.socket) {
      try {
        await this.sendLine("QUIT");
      } catch {
        // Best-effort
      }
      try {
        this.socket.end();
      } catch {
        // Already closed
      }
    }
    this.connected = false;
  }

  async send(message: SmtpMessage): Promise<Result<string, EidolonError>> {
    if (!this.connected) {
      return Err(createError(ErrorCode.EMAIL_SMTP_ERROR, "SMTP not connected"));
    }

    try {
      const { messageId, raw } = buildMimeMessage(
        this.config.from,
        message.to,
        message.subject,
        message.textBody,
        message.htmlBody,
        message.inReplyTo,
        message.references,
        message.attachments,
      );

      // MAIL FROM
      const mailResp = await this.sendLine(`MAIL FROM:<${sanitizeSmtpAddress(this.config.from)}>`);
      if (!mailResp.startsWith("250")) {
        return Err(createError(ErrorCode.EMAIL_SMTP_ERROR, `SMTP MAIL FROM failed: ${mailResp}`));
      }

      // RCPT TO for each recipient
      for (const recipient of message.to) {
        const rcptResp = await this.sendLine(`RCPT TO:<${sanitizeSmtpAddress(recipient)}>`);
        if (!rcptResp.startsWith("250")) {
          return Err(createError(ErrorCode.EMAIL_SMTP_ERROR, `SMTP RCPT TO failed: ${rcptResp}`));
        }
      }

      // DATA
      const dataResp = await this.sendLine("DATA");
      if (!dataResp.startsWith("354")) {
        return Err(createError(ErrorCode.EMAIL_SMTP_ERROR, `SMTP DATA failed: ${dataResp}`));
      }

      // Send message body, terminated by CRLF.CRLF
      // Normalize all line endings to CRLF first, then dot-stuff per RFC 5321
      const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n");
      // Dot-stuff lines starting with a dot (must match at start of line after CRLF normalization)
      const stuffed = normalized.replace(/^\.(.*)$/gm, "..$1");
      const endResp = await this.sendLine(`${stuffed}\r\n.`);
      if (!endResp.startsWith("250")) {
        return Err(createError(ErrorCode.EMAIL_SMTP_ERROR, `SMTP message send failed: ${endResp}`));
      }

      return Ok(messageId);
    } catch (cause) {
      return Err(createError(ErrorCode.EMAIL_SMTP_ERROR, "SMTP send failed", cause));
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private sendLine(line: string): Promise<string> {
    this.buffer = "";
    return new Promise<string>((resolve) => {
      // If there's already a pending resolve, reject it to prevent overwrites
      if (this.pendingResolve !== null) {
        const stale = this.pendingResolve;
        this.pendingResolve = null;
        stale("500 Overlapping SMTP command (previous promise rejected)");
      }

      const wrappedResolve = (data: string): void => {
        clearTimeout(timer);
        resolve(data);
      };

      const timer = setTimeout(() => {
        if (this.pendingResolve === wrappedResolve) {
          this.pendingResolve = null;
          resolve("500 Timeout");
        }
      }, 30_000);
      timer.unref();

      this.pendingResolve = wrappedResolve;
      if (!this.socket) {
        clearTimeout(timer);
        resolve("500 Socket not connected");
        return;
      }
      this.socket.write(new TextEncoder().encode(`${line}\r\n`));
    });
  }
}
