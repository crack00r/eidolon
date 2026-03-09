/**
 * Shared config utilities used by watcher.ts and config-reload.ts.
 */

/** Resolve a dot-separated path (e.g. "brain.accounts") to a value in a nested object. */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
