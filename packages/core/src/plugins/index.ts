/**
 * Plugin system barrel export.
 */

export { PluginLifecycleManager } from "./lifecycle.ts";
export { discoverPlugins, type LoadedPlugin } from "./loader.ts";
export { PluginRegistry } from "./registry.ts";
export { createPluginContext, type SandboxDeps } from "./sandbox.ts";
