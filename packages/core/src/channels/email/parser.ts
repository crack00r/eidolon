/**
 * Email parsing utilities for the Email channel.
 *
 * Provides functions to clean email body text, extract threading information,
 * strip signatures and quoted replies, validate addresses, and sanitize
 * untrusted email content before passing to the LLM.
 */

import type { ImapMessage } from "./imap.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThreadInfo {
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly isReply: boolean;
  /** First message ID in the thread chain (for grouping). */
  readonly threadId: string;
}

// ---------------------------------------------------------------------------
// HTML stripping
// ---------------------------------------------------------------------------

/** Common self-closing / void HTML tags that should be treated as whitespace. */
const BLOCK_TAGS = /(<\/?(br|p|div|h[1-6]|li|tr|td|th|blockquote|pre|hr)\b[^>]*>)/gi;

/** All HTML tags. */
const ALL_TAGS = /<[^>]+>/g;

/** HTML entity references. */
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

const ENTITY_RE = /&(?:amp|lt|gt|quot|#39|apos|nbsp);/gi;

/** Strip HTML tags and decode common entities. */
function stripHtml(html: string): string {
  let text = html;
  // Replace block-level tags with newlines
  text = text.replace(BLOCK_TAGS, "\n");
  // Remove remaining tags
  text = text.replace(ALL_TAGS, "");
  // Decode entities
  text = text.replace(ENTITY_RE, (match) => HTML_ENTITIES[match.toLowerCase()] ?? match);
  // Normalise whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ---------------------------------------------------------------------------
// Email body parsing
// ---------------------------------------------------------------------------

/**
 * Parse raw email body parts into clean text.
 *
 * Prefers textBody when available. Falls back to stripping HTML from htmlBody.
 * Returns empty string if both are absent.
 */
export function parseEmailBody(textBody?: string, htmlBody?: string): string {
  if (textBody && textBody.trim().length > 0) {
    return textBody.trim();
  }
  if (htmlBody && htmlBody.trim().length > 0) {
    return stripHtml(htmlBody);
  }
  return "";
}

// ---------------------------------------------------------------------------
// Thread extraction
// ---------------------------------------------------------------------------

/**
 * Extract threading metadata from an IMAP message.
 *
 * Uses In-Reply-To and References headers to determine the thread chain.
 * The threadId is the first message ID in the References chain, or the
 * message's own ID if it is a new thread.
 */
export function extractThreadInfo(message: ImapMessage): ThreadInfo {
  const refs = message.references ?? [];
  const isReply = !!message.inReplyTo || refs.length > 0;

  // Thread ID: first reference, or the message's own ID for new threads
  const threadId = refs.length > 0 ? (refs[0] as string) : message.messageId;

  return {
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: refs,
    isReply,
    threadId,
  };
}

// ---------------------------------------------------------------------------
// Signature stripping
// ---------------------------------------------------------------------------

/**
 * Common email signature delimiters.
 * Each pattern matches the delimiter line and everything after it.
 */
const SIGNATURE_PATTERNS: readonly RegExp[] = [
  // RFC 3676 signature delimiter: "-- \n" (dash dash space newline)
  /(?:^|\n)-- \n[\s\S]*$/,
  // Common delimiter without trailing space
  /(?:^|\n)--\n[\s\S]*$/,
  // "Sent from my iPhone/Android/etc."
  /(?:^|\n)Sent from my \w[\s\S]*$/i,
  // "Get Outlook for iOS"
  /(?:^|\n)Get Outlook for \w[\s\S]*$/i,
  // German: "Gesendet von meinem ..."
  /(?:^|\n)Gesendet von meinem \w[\s\S]*$/i,
  // "Von meinem iPhone gesendet"
  /(?:^|\n)Von meinem \w+ gesendet[\s\S]*$/i,
];

/**
 * Strip email signatures from text.
 *
 * Conservative approach: only strips clearly identifiable signatures
 * using well-known delimiter patterns.
 */
export function stripSignature(text: string): string {
  let result = text;
  for (const pattern of SIGNATURE_PATTERNS) {
    result = result.replace(pattern, "");
  }
  return result.trim();
}

// ---------------------------------------------------------------------------
// Quoted reply stripping
// ---------------------------------------------------------------------------

/**
 * Patterns that precede quoted text in email replies.
 * Matches "On DATE, NAME wrote:" and similar patterns in multiple languages.
 */
const QUOTE_HEADER_PATTERNS: readonly RegExp[] = [
  // English: "On Mon, Jan 1, 2026 at 10:00 AM John Doe <john@example.com> wrote:"
  /^On .+wrote:\s*$/im,
  // German: "Am 01.01.2026 um 10:00 schrieb Max Mustermann:"
  /^Am .+schrieb .+:\s*$/im,
  // French: "Le 01/01/2026 a 10:00, Jean Dupont a ecrit :"
  /^Le .+(?:a\s+[eé]crit|wrote)\s*:\s*$/im,
  // Generic separator line (many email clients)
  /^-{3,}.*Original Message.*-{3,}\s*$/im,
  // Outlook-style
  /^_{3,}\s*$/m,
  // "From: ... Sent: ... To: ... Subject: ..." block (Outlook)
  /^From:\s.+\nSent:\s.+\nTo:\s.+\nSubject:\s.+$/im,
];

/**
 * Strip quoted reply text from an email body.
 *
 * Removes lines starting with ">" (quoted text) and "On DATE wrote:" patterns.
 * Returns only the new content authored by the sender.
 */
export function stripQuotedReply(text: string): string {
  const lines = text.split("\n");
  const resultLines: string[] = [];
  let inQuotedBlock = false;

  for (const line of lines) {
    // Check if we've hit a quote header
    const isQuoteHeader = QUOTE_HEADER_PATTERNS.some((p) => p.test(line));
    if (isQuoteHeader) {
      // Everything from here on is quoted — stop
      break;
    }

    // Lines starting with > are quoted text
    if (line.trimStart().startsWith(">")) {
      inQuotedBlock = true;
      continue;
    }

    // If we were in a quoted block and encounter a non-quoted line,
    // it might be the user's inline reply — include it
    if (inQuotedBlock && line.trim().length > 0) {
      inQuotedBlock = false;
    }

    if (!inQuotedBlock) {
      resultLines.push(line);
    }
  }

  return resultLines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Email address validation
// ---------------------------------------------------------------------------

/**
 * Basic email address format validation.
 * Checks for a reasonable local@domain structure.
 * Does NOT perform DNS lookups or MX record checks.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  return EMAIL_RE.test(email);
}

// ---------------------------------------------------------------------------
// Content sanitization
// ---------------------------------------------------------------------------

/** Maximum content length after sanitization (64 KB). */
const MAX_CONTENT_LENGTH = 65_536;

/** Patterns that could be prompt injection attempts. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  // System prompt injection attempts
  /\bsystem\s*:\s*you\s+are\b/i,
  /\bignore\s+(all\s+)?previous\s+instructions\b/i,
  /\byour\s+new\s+(instructions?|role)\s+(is|are)\b/i,
  /\bforget\s+(all\s+)?(your\s+)?instructions\b/i,
  // Jailbreak markers
  /\[SYSTEM\]/i,
  /<<SYS>>/i,
  /\bDAN\s+mode\b/i,
];

/**
 * Sanitize email content before passing to the LLM.
 *
 * - Strips control characters (except newlines and tabs)
 * - Removes potential prompt injection patterns
 * - Truncates to a maximum length
 */
export function sanitizeEmailContent(content: string): string {
  let sanitized = content;

  // Strip control characters except \n \r \t
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Remove potential injection patterns (replace with harmless placeholder)
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[content filtered]");
  }

  // Truncate to maximum length
  if (sanitized.length > MAX_CONTENT_LENGTH) {
    sanitized = `${sanitized.slice(0, MAX_CONTENT_LENGTH)}\n[... content truncated]`;
  }

  return sanitized.trim();
}
