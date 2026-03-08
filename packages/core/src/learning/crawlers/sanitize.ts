/**
 * Content sanitization for scraped web content.
 *
 * Strips known prompt injection patterns, shell command blocks,
 * and other potentially dangerous content before LLM evaluation.
 */

/** Patterns that indicate prompt injection attempts. */
const INJECTION_PATTERNS: readonly RegExp[] = [
  // System prompt overrides
  /\bsystem\s*:\s*/gi,
  /\byou\s+are\s+now\b/gi,
  /\bignore\s+(all\s+)?previous\s+instructions?\b/gi,
  /\bforget\s+(all\s+)?previous\b/gi,
  /\bact\s+as\b/gi,
  /\bpretend\s+to\s+be\b/gi,
  // Delimiter injection
  /```(?:bash|sh|shell|cmd|powershell|ps1)\s*\n[^`]*(?:rm\s+-rf|sudo|chmod|mkfs|dd\s+if|curl.*\|\s*(?:bash|sh)|wget.*\|\s*(?:bash|sh))/gis,
  // Encoded payloads
  /(?:eval|exec)\s*\(/gi,
];

/** Dangerous shell commands that should never appear in content for LLM evaluation. */
const DANGEROUS_COMMAND_PATTERNS: readonly RegExp[] = [
  /\brm\s+-rf\s+[/~]/g,
  /\bsudo\s+/g,
  /\bmkfs\b/g,
  /\bdd\s+if=/g,
  /\b(?:curl|wget)\s+.*\|\s*(?:bash|sh)\b/g,
  /\bchmod\s+777\b/g,
  /:\(\)\s*\{[^}]*\}\s*;/g, // fork bomb
];

/**
 * Sanitize web-scraped content before LLM evaluation.
 *
 * Replaces known injection patterns with safe placeholders and
 * truncates excessively long content.
 */
export function sanitizeContent(raw: string, maxLength = 50_000): string {
  let content = raw;

  // Strip injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    content = content.replace(pattern, "[REDACTED]");
  }

  // Strip dangerous shell commands
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    content = content.replace(pattern, "[UNSAFE_CMD]");
  }

  // Strip excessive whitespace
  content = content.replace(/\n{4,}/g, "\n\n\n");
  content = content.replace(/[ \t]{10,}/g, " ");

  // Truncate
  if (content.length > maxLength) {
    content = `${content.slice(0, maxLength)}\n\n[TRUNCATED]`;
  }

  return content.trim();
}
