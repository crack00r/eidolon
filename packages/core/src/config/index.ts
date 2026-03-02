// @eidolon/core config module -- barrel exports

export { resolveDefaults } from "./defaults.ts";
export { applyEnvOverrides } from "./env.ts";
export { loadConfig, validateAndResolve } from "./loader.ts";
export { getCacheDir, getConfigDir, getConfigPath, getDataDir, getLogDir, getPidFilePath } from "./paths.ts";
export type { ConfigChangeHandler } from "./watcher.ts";
export { ConfigWatcher } from "./watcher.ts";
