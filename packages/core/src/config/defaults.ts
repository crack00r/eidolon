/**
 * Fill in platform-dependent defaults that Zod can't provide
 * (because they depend on the runtime platform and environment).
 */

import type { EidolonConfig } from "@eidolon/protocol";
import { getDataDir, getLogDir, getPidFilePath } from "./paths.ts";

export function resolveDefaults(config: EidolonConfig): EidolonConfig {
  return {
    ...config,
    database: {
      ...config.database,
      directory: config.database.directory || getDataDir(),
    },
    logging: {
      ...config.logging,
      directory: config.logging.directory || getLogDir(),
    },
    daemon: {
      ...config.daemon,
      pidFile: config.daemon.pidFile || getPidFilePath(),
    },
  };
}
