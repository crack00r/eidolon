/**
 * Markdown to HTML email formatter.
 *
 * Converts Claude's markdown responses into email-safe HTML with inline
 * styles for broad email client compatibility. Also generates plain text
 * alternatives and handles subject line formatting with threading prefixes.
 */

// ---------------------------------------------------------------------------
// Markdown to email-safe HTML
// ---------------------------------------------------------------------------

/**
 * Convert markdown text to email-safe HTML.
 *
 * Handles: headers, bold, italic, inline code, fenced code blocks,
 * unordered lists, ordered lists, links, and horizontal rules.
 * Uses inline styles instead of CSS classes for email compatibility.
 */
export function markdownToEmailHtml(markdown: string): string {
  if (markdown.length === 0) return "";

  const lines = markdown.split("\n");
  const htmlLines: string[] = [];
  let inCodeBlock = false;
  let codeBlockContent: string[] = [];
  let inList: "ul" | "ol" | null = null;

  for (const line of lines) {
    // Fenced code block toggle
    if (line.trimStart().startsWith("```")) {
      if (inCodeBlock) {
        // End code block
        const code = escapeHtml(codeBlockContent.join("\n"));
        htmlLines.push(
          `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto;font-family:monospace;font-size:13px;line-height:1.4;"><code>${code}</code></pre>`,
        );
        codeBlockContent = [];
        inCodeBlock = false;
      } else {
        // Close any open list
        if (inList) {
          htmlLines.push(inList === "ul" ? "</ul>" : "</ol>");
          inList = null;
        }
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Close list if line is not a list item
    const isUnorderedItem = /^\s*[-*+]\s/.test(line);
    const isOrderedItem = /^\s*\d+\.\s/.test(line);
    if (inList && !isUnorderedItem && !isOrderedItem && line.trim().length > 0) {
      htmlLines.push(inList === "ul" ? "</ul>" : "</ol>");
      inList = null;
    }

    // Empty line
    if (line.trim().length === 0) {
      if (inList) {
        htmlLines.push(inList === "ul" ? "</ul>" : "</ol>");
        inList = null;
      }
      htmlLines.push("<br>");
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headerMatch) {
      const level = headerMatch[1]?.length ?? 1;
      const text = formatInline(headerMatch[2] ?? "");
      const sizes: Record<number, string> = { 1: "24px", 2: "20px", 3: "18px", 4: "16px", 5: "14px", 6: "13px" };
      const size = sizes[level] ?? "16px";
      htmlLines.push(`<h${level} style="font-size:${size};margin:16px 0 8px 0;color:#333;">${text}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      htmlLines.push('<hr style="border:none;border-top:1px solid #ddd;margin:16px 0;">');
      continue;
    }

    // Unordered list item
    if (isUnorderedItem) {
      const content = formatInline(line.replace(/^\s*[-*+]\s/, ""));
      if (inList !== "ul") {
        if (inList) htmlLines.push("</ol>");
        htmlLines.push('<ul style="margin:4px 0;padding-left:24px;">');
        inList = "ul";
      }
      htmlLines.push(`<li style="margin:2px 0;">${content}</li>`);
      continue;
    }

    // Ordered list item
    if (isOrderedItem) {
      const content = formatInline(line.replace(/^\s*\d+\.\s/, ""));
      if (inList !== "ol") {
        if (inList) htmlLines.push("</ul>");
        htmlLines.push('<ol style="margin:4px 0;padding-left:24px;">');
        inList = "ol";
      }
      htmlLines.push(`<li style="margin:2px 0;">${content}</li>`);
      continue;
    }

    // Regular paragraph
    htmlLines.push(`<p style="margin:4px 0;line-height:1.5;">${formatInline(line)}</p>`);
  }

  // Close any open code block
  if (inCodeBlock && codeBlockContent.length > 0) {
    const code = escapeHtml(codeBlockContent.join("\n"));
    htmlLines.push(
      `<pre style="background:#f4f4f4;padding:12px;border-radius:4px;overflow-x:auto;font-family:monospace;font-size:13px;line-height:1.4;"><code>${code}</code></pre>`,
    );
  }

  // Close any open list
  if (inList) {
    htmlLines.push(inList === "ul" ? "</ul>" : "</ol>");
  }

  return htmlLines.join("\n");
}

// ---------------------------------------------------------------------------
// Inline formatting
// ---------------------------------------------------------------------------

/** Apply inline markdown formatting (bold, italic, code, links). */
function formatInline(text: string): string {
  let result = escapeHtml(text);

  // Inline code: `code`
  result = result.replace(
    /`([^`]+)`/g,
    '<code style="background:#f4f4f4;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:13px;">$1</code>',
  );

  // Bold + italic: ***text***
  result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");

  // Bold: **text**
  result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // Italic: *text* or _text_
  result = result.replace(/\*(.+?)\*/g, "<em>$1</em>");
  result = result.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<em>$1</em>");

  // Links: [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" style="color:#0066cc;text-decoration:underline;">$1</a>',
  );

  return result;
}

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// Email HTML template
// ---------------------------------------------------------------------------

/**
 * Wrap body HTML in a complete, email-client-compatible HTML document.
 *
 * Uses table-based layout for maximum compatibility across email clients.
 * Includes responsive max-width and Eidolon branding footer.
 */
export function buildEmailHtml(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Eidolon</title>
</head>
<body style="margin:0;padding:0;background:#f9f9f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;">
    <tr>
      <td align="center" style="padding:20px 10px;">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;border:1px solid #e0e0e0;">
          <tr>
            <td style="padding:24px 32px;font-size:15px;color:#333;line-height:1.6;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:12px 32px;border-top:1px solid #eee;font-size:12px;color:#999;text-align:center;">
              Sent by Eidolon AI Assistant
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Complete email response formatting
// ---------------------------------------------------------------------------

/**
 * Format a markdown response into a complete email with HTML and plain text parts.
 *
 * @param markdown - The Claude markdown response text
 * @param subjectPrefix - Prefix to prepend to the subject (e.g. "[Eidolon]")
 * @returns Object with subject, html, and text parts ready for SMTP
 */
export function formatEmailResponse(
  markdown: string,
  subjectPrefix: string,
): { subject: string; html: string; text: string } {
  const bodyHtml = markdownToEmailHtml(markdown);
  const html = buildEmailHtml(bodyHtml);

  // Plain text: use the original markdown (already human-readable)
  const text = markdown;

  // Build subject from first line or a default
  const firstLine = markdown.split("\n").find((l) => l.trim().length > 0) ?? "Response";
  // Strip markdown formatting from subject
  const cleanSubject = firstLine
    .replace(/^#+\s*/, "")
    .replace(/[*_`]/g, "")
    .slice(0, 78);
  const subject = subjectPrefix ? `${subjectPrefix} ${cleanSubject}` : cleanSubject;

  return { subject, html, text };
}

// ---------------------------------------------------------------------------
// Reply subject builder
// ---------------------------------------------------------------------------

/**
 * Build a reply subject line.
 *
 * - Adds "Re: " if not already present
 * - Adds the configured prefix (e.g. "[Eidolon]") if not already present
 * - Avoids duplicating "Re: Re: " chains
 */
export function buildReplySubject(originalSubject: string, prefix: string): string {
  let subject = originalSubject.trim();

  // Strip existing "Re: " prefixes to avoid duplication
  while (/^Re:\s*/i.test(subject)) {
    subject = subject.replace(/^Re:\s*/i, "");
  }

  // Strip existing prefix to avoid duplication
  if (prefix && subject.startsWith(prefix)) {
    subject = subject.slice(prefix.length).trim();
  }

  // Rebuild with single "Re: " and prefix
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  parts.push(`Re: ${subject}`);

  return parts.join(" ");
}
