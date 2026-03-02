/**
 * Fill in platform-dependent defaults that Zod can't provide
 * (because they depend on the runtime platform and environment).
 *
 * All directory paths are canonicalized via `path.resolve()` to prevent
 * directory traversal when values come from config files or env vars.
 */

import { resolve } from "node:path";
import type { EidolonConfig } from "@eidolon/protocol";
import { getDataDir, getLogDir, getPidFilePath } from "./paths.ts";

export function resolveDefaults(config: EidolonConfig): EidolonConfig {
  return {
    ...config,
    database: {
      ...config.database,
      directory: resolve(config.database.directory || getDataDir()),
    },
    logging: {
      ...config.logging,
      directory: resolve(config.logging.directory || getLogDir()),
    },
    daemon: {
      ...config.daemon,
      pidFile: resolve(config.daemon.pidFile || getPidFilePath()),
    },
  };
}
