/**
 * DeduplicationChecker -- prevents storing duplicate discoveries.
 *
 * URL normalization removes tracking parameters, fragments, trailing slashes,
 * and lowercases the hostname for consistent comparison.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";
import type { DiscoveryEngine } from "./discovery.js";

/** UTM and common tracking parameters to strip. */
const TRACKING_PARAMS = new Set([
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

export class DeduplicationChecker {
  private readonly engine: DiscoveryEngine;
  private readonly logger: Logger;

  constructor(engine: DiscoveryEngine, logger: Logger) {
    this.engine = engine;
    this.logger = logger.child("deduplication");
  }

  /** Check if a URL (normalized) is already known. */
  isKnown(url: string): Result<boolean, EidolonError> {
    const normalized = DeduplicationChecker.normalizeUrl(url);
    const result = this.engine.isKnown(normalized);

    if (result.ok && result.value) {
      this.logger.debug("isKnown", `Skipping known URL: ${normalized}`);
    }

    return result;
  }

  /** Normalize a URL for comparison. */
  static normalizeUrl(url: string): string {
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
}
