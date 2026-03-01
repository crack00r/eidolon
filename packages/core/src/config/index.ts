// @eidolon/core config module -- barrel exports

export { resolveDefaults } from "./defaults.js";
export { applyEnvOverrides } from "./env.js";
export { loadConfig, validateAndResolve } from "./loader.js";
export { getCacheDir, getConfigDir, getConfigPath, getDataDir, getLogDir, getPidFilePath } from "./paths.js";
export type { ConfigChangeHandler } from "./watcher.js";
export { ConfigWatcher } from "./watcher.js";
