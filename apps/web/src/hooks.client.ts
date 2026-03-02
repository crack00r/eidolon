/**
 * Client-side error hook — catches unhandled errors in the SvelteKit
 * client runtime and logs them via the client logger.
 */

import { clientLog } from "$lib/logger";
import { sanitizeErrorForDisplay } from "$lib/utils";

/**
 * Called by SvelteKit when an unexpected error occurs on the client.
 * Logs the error to the ring buffer for phone-home reporting and
 * returns a sanitized message for display.
 */
export function handleError({ error, status, message }: { error: unknown; status: number; message: string }): {
  message: string;
} {
  clientLog("error", "hooks.client", `Unhandled client error (${status}): ${message}`, error);

  return {
    message: sanitizeErrorForDisplay(error, message),
  };
}
