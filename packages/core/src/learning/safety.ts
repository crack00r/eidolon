/**
 * SafetyClassifier -- classifies the safety level of discovered content.
 *
 * ABSOLUTE RULE: Code changes are NEVER classified as 'safe'.
 * Any content containing code, commands, or system modifications
 * is classified as 'needs_approval' at minimum.
 *
 * Classification levels:
 *   - dangerous: shell commands, credential patterns, malicious patterns
 *   - needs_approval: code snippets, file paths, config changes, dependencies
 *   - safe: pure informational content without actionable code
 */

import type { Logger } from "../logging/logger.ts";

export type SafetyLevel = "safe" | "needs_approval" | "dangerous";

export interface SafetyResult {
  readonly level: SafetyLevel;
  readonly reason: string;
  readonly flags: readonly string[];
}

/** Dangerous shell command patterns. */
const DANGEROUS_PATTERNS: ReadonlyArray<{ pattern: RegExp; flag: string }> = [
  { pattern: /rm\s+-rf\s/i, flag: "destructive_command" },
  { pattern: /sudo\s/i, flag: "elevated_privileges" },
  { pattern: /chmod\s+777/i, flag: "insecure_permissions" },
  { pattern: /mkfs\./i, flag: "filesystem_format" },
  { pattern: /dd\s+if=/i, flag: "disk_overwrite" },
  { pattern: /:\(\)\s*\{/i, flag: "fork_bomb" },
  { pattern: />\s*\/dev\/sd/i, flag: "disk_overwrite" },
  { pattern: /curl\s.*\|\s*(ba)?sh/i, flag: "remote_execution" },
  { pattern: /wget\s.*\|\s*(ba)?sh/i, flag: "remote_execution" },
  { pattern: /eval\s*\(/i, flag: "eval_execution" },
];

/** Credential and secret patterns. */
const CREDENTIAL_PATTERNS: ReadonlyArray<{ pattern: RegExp; flag: string }> = [
  { pattern: /password\s*[:=]\s*['"][^'"]+['"]/i, flag: "contains_password" },
  { pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/i, flag: "contains_api_key" },
  { pattern: /token\s*[:=]\s*['"][A-Za-z0-9_\-.]{20,}['"]/i, flag: "contains_token" },
  { pattern: /secret\s*[:=]\s*['"][^'"]+['"]/i, flag: "contains_secret" },
  { pattern: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i, flag: "contains_private_key" },
  { pattern: /AWS[_-]?SECRET[_-]?ACCESS[_-]?KEY/i, flag: "contains_aws_key" },
];

/** Code and system modification patterns. */
const CODE_PATTERNS: ReadonlyArray<{ pattern: RegExp; flag: string }> = [
  { pattern: /```[\s\S]*?```/, flag: "contains_code_block" },
  { pattern: /(?:src|packages|lib|dist)\/\S+\.\w+/i, flag: "references_file_path" },
  { pattern: /npm\s+install\s/i, flag: "npm_install" },
  { pattern: /pnpm\s+add\s/i, flag: "pnpm_add" },
  { pattern: /yarn\s+add\s/i, flag: "yarn_add" },
  { pattern: /git\s+clone\s/i, flag: "git_clone" },
  { pattern: /pip\s+install\s/i, flag: "pip_install" },
  { pattern: /import\s+\{.*\}\s+from\s+['"]/, flag: "contains_import" },
  { pattern: /require\s*\(\s*['"]/, flag: "contains_require" },
  { pattern: /function\s+\w+\s*\(/, flag: "contains_function" },
  { pattern: /class\s+\w+\s*(\{|extends)/, flag: "contains_class" },
  { pattern: /const\s+\w+\s*=\s*(?:async\s+)?\(/, flag: "contains_arrow_fn" },
  { pattern: /export\s+(default\s+)?(?:function|class|const|interface|type)\s/, flag: "contains_export" },
  { pattern: /\bDockerfile\b/i, flag: "references_docker" },
  { pattern: /docker\s+(?:run|build|compose)/i, flag: "docker_command" },
];

/**
 * Map of common Cyrillic homoglyphs to their ASCII equivalents.
 * These characters look identical to Latin letters but have different code points,
 * which attackers use to bypass pattern-based safety checks.
 */
const HOMOGLYPH_MAP: ReadonlyMap<string, string> = new Map([
  ["\u0435", "e"], // Cyrillic е → Latin e
  ["\u0430", "a"], // Cyrillic а → Latin a
  ["\u043E", "o"], // Cyrillic о → Latin o
  ["\u0441", "c"], // Cyrillic с → Latin c
  ["\u0455", "s"], // Cyrillic ѕ → Latin s
  ["\u0440", "p"], // Cyrillic р → Latin p
  ["\u0443", "y"], // Cyrillic у → Latin y (visually similar in some fonts)
  ["\u0445", "x"], // Cyrillic х → Latin x
  ["\u0456", "i"], // Cyrillic і → Latin i
  ["\u0458", "j"], // Cyrillic ј → Latin j
  ["\u04BB", "h"], // Cyrillic һ → Latin h
  ["\u0501", "d"], // Cyrillic ԁ → Latin d
  ["\u051B", "q"], // Cyrillic ԛ → Latin q
  ["\u051D", "w"], // Cyrillic ԝ → Latin w
]);

/**
 * Replace Cyrillic homoglyphs with their ASCII equivalents.
 */
function replaceHomoglyphs(text: string): string {
  let result = "";
  for (const ch of text) {
    const replacement = HOMOGLYPH_MAP.get(ch);
    result += replacement ?? ch;
  }
  return result;
}

/**
 * Strip Unicode format characters (category Cf) from text.
 * These invisible characters (soft hyphens, RTL/LTR marks, etc.) can be used
 * to break up patterns and bypass detection.
 */
function stripFormatCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /[\u00AD\u061C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u206A-\u206F\uFFF9-\uFFFB]/g,
    "",
  );
}

/**
 * Normalize text to prevent classification bypass via encoding tricks.
 * Strips zero-width characters, format characters, applies NFKD normalization,
 * replaces Cyrillic homoglyphs with ASCII equivalents, and lowercases.
 */
function normalizeForClassification(text: string): string {
  // Strip zero-width characters: U+200B, U+200C, U+200D, U+FEFF
  const stripped = text.replace(/\u200B|\u200C|\u200D|\uFEFF/g, "");
  // NFKD Unicode normalization (decomposes compatibility characters)
  const normalized = stripped.normalize("NFKD");
  // Strip Unicode format characters (category Cf)
  const noFormat = stripFormatCharacters(normalized);
  // Replace Cyrillic homoglyphs with ASCII equivalents
  const deconfused = replaceHomoglyphs(noFormat);
  return deconfused.toLowerCase();
}

/** Minimum content length threshold for defaulting to needs_approval. */
const SAFE_MAX_LENGTH = 500;

export { normalizeForClassification };

export class SafetyClassifier {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child("safety");
  }

  /** Classify the safety level of a discovery. */
  classify(title: string, content: string, sourceType: string): SafetyResult {
    // Finding #2: Normalize input to prevent encoding-based bypass
    const combined = normalizeForClassification(`${title}\n${content}`);
    const flags: string[] = [];

    // Check dangerous patterns first (highest priority)
    for (const { pattern, flag } of DANGEROUS_PATTERNS) {
      if (pattern.test(combined)) {
        flags.push(flag);
      }
    }

    if (flags.length > 0) {
      const result: SafetyResult = {
        level: "dangerous",
        reason: `Dangerous patterns detected: ${flags.join(", ")}`,
        flags,
      };
      this.logger.warn("classify", result.reason, { title, sourceType });
      return result;
    }

    // Check credential patterns (also dangerous)
    for (const { pattern, flag } of CREDENTIAL_PATTERNS) {
      if (pattern.test(combined)) {
        flags.push(flag);
      }
    }

    if (flags.length > 0) {
      const result: SafetyResult = {
        level: "dangerous",
        reason: `Credential patterns detected: ${flags.join(", ")}`,
        flags,
      };
      this.logger.warn("classify", result.reason, { title, sourceType });
      return result;
    }

    // Check code patterns (needs_approval)
    for (const { pattern, flag } of CODE_PATTERNS) {
      if (pattern.test(combined)) {
        flags.push(flag);
      }
    }

    if (flags.length > 0) {
      const result: SafetyResult = {
        level: "needs_approval",
        reason: `Code or system modification detected: ${flags.join(", ")}`,
        flags,
      };
      this.logger.debug("classify", result.reason, { title, sourceType });
      return result;
    }

    // GitHub source always needs approval (repos contain code)
    if (sourceType === "github") {
      const result: SafetyResult = {
        level: "needs_approval",
        reason: "GitHub source -- likely contains code",
        flags: ["github_source"],
      };
      this.logger.debug("classify", result.reason, { title });
      return result;
    }

    // Finding #3: Only return "safe" for short, purely informational content.
    // Longer content defaults to "needs_approval" to avoid false negatives.
    if (combined.length > SAFE_MAX_LENGTH) {
      const result: SafetyResult = {
        level: "needs_approval",
        reason: "Content exceeds safe-length threshold — requires review",
        flags: ["content_length_threshold"],
      };
      this.logger.debug("classify", result.reason, { title, sourceType, length: combined.length });
      return result;
    }

    // Pure informational content (short, no patterns matched)
    const result: SafetyResult = {
      level: "safe",
      reason: "No code, commands, or sensitive patterns detected",
      flags: [],
    };
    this.logger.debug("classify", result.reason, { title, sourceType });
    return result;
  }
}
