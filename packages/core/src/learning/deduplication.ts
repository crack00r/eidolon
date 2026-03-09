/**
 * DeduplicationChecker -- prevents storing duplicate discoveries.
 *
 * URL normalization is delegated to the shared url-normalize module.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import type { DiscoveryEngine } from "./discovery.ts";
import { normalizeUrl } from "./url-normalize.ts";

export class DeduplicationChecker {
  private readonly engine: DiscoveryEngine;
  private readonly logger: Logger;

  constructor(engine: DiscoveryEngine, logger: Logger) {
    this.engine = engine;
    this.logger = logger.child("deduplication");
  }

  /** Check if a URL (normalized) is already known. */
  isKnown(url: string): Result<boolean, EidolonError> {
    // engine.isKnown() already normalizes internally, so pass raw URL
    const result = this.engine.isKnown(url);

    if (result.ok && result.value) {
      this.logger.debug("isKnown", `Skipping known URL: ${url}`);
    }

    return result;
  }

  /** Normalize a URL for comparison. */
  static normalizeUrl(url: string): string {
    return normalizeUrl(url);
  }
}
