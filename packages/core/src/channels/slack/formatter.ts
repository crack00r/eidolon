/**
 * Slack mrkdwn formatter.
 *
 * Converts standard markdown (as Claude outputs) to Slack mrkdwn format
 * and handles message splitting for Slack's 4000-character limit.
 */

/** Slack's maximum message length for chat.postMessage. */
const SLACK_MAX_LENGTH = 4000;

/**
 * Convert standard markdown to Slack mrkdwn format.
 *
 * Conversions:
 *  - `**bold**` -> `*bold*`
 *  - `~~strike~~` -> `~strike~`
 *  - `[text](url)` -> `<url|text>`
 *  - ````lang\ncode```` -> ````code```` (strip language hints)
 *  - Inline code, italic, blockquotes pass through unchanged.
 */
export function formatForSlack(markdown: string): string {
  if (!markdown) return markdown;

  let result = markdown;

  // Protect code blocks first -- extract and replace with placeholders
  const codeBlocks: string[] = [];
  result = result.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, (_match, code: string) => {
    const placeholder = `\x00CB${codeBlocks.length}\x00`;
    codeBlocks.push(`\`\`\`${code}\`\`\``);
    return placeholder;
  });

  // Protect inline code -- extract and replace with placeholders
  const inlineCode: string[] = [];
  result = result.replace(/`([^`]+)`/g, (_match, code: string) => {
    const placeholder = `\x00IC${inlineCode.length}\x00`;
    inlineCode.push(`\`${code}\``);
    return placeholder;
  });

  // Bold: **text** -> *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Strikethrough: ~~text~~ -> ~text~
  result = result.replace(/~~(.+?)~~/g, "~$1~");

  // Links: [text](url) -> <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Restore inline code
  for (let i = 0; i < inlineCode.length; i++) {
    result = result.replace(`\x00IC${i}\x00`, inlineCode[i] as string);
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CB${i}\x00`, codeBlocks[i] as string);
  }

  return result;
}

/**
 * Split a long message into chunks respecting Slack's 4000-character limit.
 *
 * Splitting strategy (same as Discord/Telegram):
 *  1. Try paragraph boundaries (\n\n).
 *  2. Try line boundaries (\n).
 *  3. Hard cut at maxLength.
 */
export function splitSlackMessage(text: string, maxLength: number = SLACK_MAX_LENGTH): string[] {
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
