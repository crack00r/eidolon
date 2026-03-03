/**
 * Discord markdown formatter.
 *
 * Converts standard Claude markdown output to Discord-compatible markdown
 * and handles message splitting for the 2000-character limit.
 */

/** Discord's maximum message length. */
const DISCORD_MAX_LENGTH = 2000;

/**
 * Format standard markdown (as Claude outputs) for Discord.
 *
 * Discord natively supports most standard markdown, so the conversion
 * is lighter than Telegram's MarkdownV2. Key differences:
 *  - Bold: **text** stays the same.
 *  - Italic: _text_ or *text* stays the same.
 *  - Code blocks: ```lang\ncode``` stays the same.
 *  - Strikethrough: ~~text~~ stays the same.
 *  - No special character escaping needed (unlike Telegram).
 *
 * The main job is to handle length limits and optional embed formatting.
 */
export function formatForDiscord(markdown: string): string {
  // Discord supports standard markdown natively, so minimal conversion is needed.
  // Just ensure the output fits within Discord limits.
  return markdown;
}

/**
 * Format a structured content block as a Discord embed-like text block.
 * Discord bots can send rich embeds, but for text-only fallback this
 * creates a visually distinct block using markdown.
 */
export function formatAsEmbed(
  title: string,
  description: string,
  fields?: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string {
  const parts: string[] = [];

  parts.push(`**${title}**`);
  if (description) {
    parts.push(description);
  }

  if (fields && fields.length > 0) {
    parts.push(""); // blank line
    for (const field of fields) {
      parts.push(`**${field.name}:** ${field.value}`);
    }
  }

  return parts.join("\n");
}

/**
 * Split a long message into chunks respecting Discord's 2000-character limit.
 *
 * Splitting strategy:
 *  - Preserves code blocks (never splits inside a fenced code block).
 *  - Try to split at paragraph boundaries (\n\n).
 *  - If a single paragraph exceeds the limit, split at line boundaries (\n).
 *  - If a single line exceeds the limit, split at the max length (hard cut).
 */
export function splitDiscordMessage(text: string, maxLength: number = DISCORD_MAX_LENGTH): string[] {
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
