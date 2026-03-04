/**
 * WhatsApp message formatter.
 *
 * Converts standard Claude markdown output to WhatsApp-compatible formatting
 * and handles message splitting for the 4096-character limit.
 *
 * WhatsApp supports a subset of formatting:
 *  - Bold: *text*
 *  - Italic: _text_
 *  - Strikethrough: ~text~
 *  - Monospace: ```text```
 *  - Inline code: `text`  (not officially documented but widely supported)
 *
 * Unlike Telegram MarkdownV2, no special escaping is needed for plain text.
 */

/** WhatsApp's maximum message length. */
const WHATSAPP_MAX_LENGTH = 4096;

/**
 * Convert standard markdown (as Claude outputs) to WhatsApp formatting.
 *
 * Conversion rules:
 *  - `**text**` -> `*text*` (bold)
 *  - `_text_` stays the same (italic)
 *  - `~~text~~` -> `~text~` (strikethrough)
 *  - Fenced code blocks stay as ```code``` (supported natively)
 *  - Inline code `text` stays the same
 *  - Headers `# text` -> `*text*` (bold, since WhatsApp has no header support)
 *  - Bullet lists stay as-is (WhatsApp renders them fine as plain text)
 */
export function formatForWhatsApp(markdown: string): string {
  let text = markdown;

  // Preserve fenced code blocks (extract to avoid mangling)
  const codeBlocks: string[] = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, _lang: string, code: string) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`\`\`\`${code}\`\`\``);
    return `\x00CB${idx}\x00`;
  });

  // Preserve inline code
  const inlineCode: string[] = [];
  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCode.length;
    inlineCode.push(`\`${code}\``);
    return `\x00IC${idx}\x00`;
  });

  // Convert headers to bold (# Header -> *Header*)
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (_match, content: string) => {
    return `*${content.trim()}*`;
  });

  // Convert bold+italic ***text*** -> *_text_*
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, "*_$1_*");

  // Convert bold **text** -> *text*
  text = text.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Convert strikethrough ~~text~~ -> ~text~
  text = text.replace(/~~(.+?)~~/g, "~$1~");

  // _text_ stays the same for italic (WhatsApp native)

  // Restore inline code
  for (let i = 0; i < inlineCode.length; i++) {
    text = text.replace(`\x00IC${i}\x00`, inlineCode[i] as string);
  }

  // Restore code blocks
  for (let i = 0; i < codeBlocks.length; i++) {
    text = text.replace(`\x00CB${i}\x00`, codeBlocks[i] as string);
  }

  return text;
}

/**
 * Split a long message into chunks respecting WhatsApp's 4096-character limit.
 *
 * Splitting strategy:
 *  - Try to split at paragraph boundaries (\n\n).
 *  - If a single paragraph exceeds the limit, split at line boundaries (\n).
 *  - If a single line exceeds the limit, split at the max length (hard cut).
 */
export function splitWhatsAppMessage(text: string, maxLength: number = WHATSAPP_MAX_LENGTH): string[] {
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
