/**
 * Shared utility functions for the Eidolon desktop client.
 */

/**
 * Strip internal details (file paths, stack traces) from error messages
 * shown to users. Only exposes the high-level error description.
 *
 * @param err    - The caught error value (may not be an Error instance)
 * @param fallback - Fallback message when err is not an Error or message is empty
 */
export function sanitizeErrorForDisplay(err: unknown, fallback = "An unexpected error occurred"): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message
    .replace(/\/[^\s:]+\.[a-z]+/gi, "[path]")
    .replace(/[A-Z]:\\[^\s:]+\.[a-z]+/gi, "[path]")
    .replace(/\n\s+at\s+.*/g, "")
    .trim();
  return msg || fallback;
}
