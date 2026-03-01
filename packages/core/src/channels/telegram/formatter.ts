/**
 * Telegram MarkdownV2 formatter.
 *
 * Converts standard Claude markdown output to Telegram MarkdownV2 format
 * and handles message splitting for the 4096-character limit.
 */

/** Characters that must be escaped in Telegram MarkdownV2 outside of formatting. */
const SPECIAL_CHARS = /([_*[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Escape special characters for Telegram MarkdownV2.
 * All characters listed in the Telegram Bot API docs must be prefixed with `\`.
 */
export function escapeTelegramMarkdown(text: string): string {
  return text.replace(SPECIAL_CHARS, "\\$1");
}

/**
 * Convert standard markdown (as Claude outputs) to Telegram MarkdownV2.
 *
 * Strategy:
 *  1. Extract fenced code blocks and inline code — leave them untouched (Telegram uses the same syntax).
 *  2. Convert bold `**text**` → `*text*` (Telegram style).
 *  3. Italic `_text_` stays the same in Telegram.
 *  4. Escape remaining special characters in plain text segments.
 *  5. Re-insert code blocks.
 */
export function formatForTelegram(markdown: string): string {
  // Placeholder map: code blocks and inline code are extracted to avoid double-escaping.
  const placeholders: string[] = [];

  function placeholder(content: string): string {
    const idx = placeholders.length;
    placeholders.push(content);
    return `\x00PH${idx}\x00`;
  }

  let text = markdown;

  // 1. Extract fenced code blocks (```lang\n...\n```)
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang: string, code: string) => {
    // Telegram MarkdownV2 code blocks: ```lang\ncode```
    return placeholder(`\`\`\`${lang}\n${code}\`\`\``);
  });

  // 2. Extract inline code (`...`)
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    return placeholder(`\`${code}\``);
  });

  // 3. Extract bold+italic `***text***` → Telegram bold-italic (not well supported, use bold)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, (_match, inner: string) => {
    return placeholder(`*${escapeTelegramMarkdown(inner)}*`);
  });

  // 4. Convert bold `**text**` → `*text*`
  text = text.replace(/\*\*(.+?)\*\*/g, (_match, inner: string) => {
    return placeholder(`*${escapeTelegramMarkdown(inner)}*`);
  });

  // 5. Convert italic `_text_` → `_text_` (same syntax, but must escape inner)
  text = text.replace(/_(.+?)_/g, (_match, inner: string) => {
    return placeholder(`_${escapeTelegramMarkdown(inner)}_`);
  });

  // 6. Convert strikethrough `~~text~~` → `~text~`
  text = text.replace(/~~(.+?)~~/g, (_match, inner: string) => {
    return placeholder(`~${escapeTelegramMarkdown(inner)}~`);
  });

  // 7. Escape all remaining special characters in plain text
  text = escapeTelegramMarkdown(text);

  // 8. Re-insert placeholders
  for (let i = 0; i < placeholders.length; i++) {
    text = text.replace(`\x00PH${i}\x00`, placeholders[i] as string);
  }

  return text;
}

/**
 * Split a long message into chunks respecting Telegram's character limit.
 *
 * Splitting strategy:
 *  - Try to split at paragraph boundaries (`\n\n`).
 *  - If a single paragraph exceeds the limit, split at line boundaries (`\n`).
 *  - If a single line exceeds the limit, split at the max length (hard cut).
 */
export function splitMessage(text: string, maxLength = 4096): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Try paragraph boundary
    let splitIdx = findLastSplitPoint(remaining, "\n\n", maxLength);

    // Try line boundary
    if (splitIdx === -1) {
      splitIdx = findLastSplitPoint(remaining, "\n", maxLength);
    }

    // Hard cut
    if (splitIdx === -1) {
      splitIdx = maxLength;
    }

    chunks.push(remaining.slice(0, splitIdx).trimEnd());
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

/**
 * Find the last occurrence of `delimiter` within `maxLength` characters.
 * Returns the index right after the delimiter, or -1 if not found.
 */
function findLastSplitPoint(text: string, delimiter: string, maxLength: number): number {
  const searchRegion = text.slice(0, maxLength);
  const idx = searchRegion.lastIndexOf(delimiter);
  if (idx <= 0) return -1;
  return idx + delimiter.length;
}
