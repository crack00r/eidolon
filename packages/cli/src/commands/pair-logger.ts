/**
 * Minimal silent logger for CLI commands that need a Logger instance
 * but don't need actual log output.
 */

import type { Logger } from "@eidolon/core";

export function createLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}
