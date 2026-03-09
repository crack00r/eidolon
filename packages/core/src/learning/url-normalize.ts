/**
 * Shared URL normalization utilities for deduplication and discovery.
 *
 * Removes tracking parameters, fragments, trailing slashes,
 * and lowercases the hostname for consistent comparison.
 */

/** UTM and common tracking parameters to strip. */
export const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "fbclid",
  "gclid",
  "ref",
  "source",
  "mc_cid",
  "mc_eid",
]);

/** Normalize a URL for consistent storage and deduplication. */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);

    // Lowercase hostname
    parsed.hostname = parsed.hostname.toLowerCase();

    // Remove tracking parameters
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }

    // Remove fragment
    parsed.hash = "";

    // Build normalized string and remove trailing slash
    let normalized = parsed.toString();
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    return normalized;
  } catch {
    // If URL parsing fails, return as-is (lowercase)
    return url.toLowerCase().replace(/\/$/, "");
  }
}
