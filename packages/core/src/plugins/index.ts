/**
 * Plugin system barrel export.
 */

export { discoverPlugins, type LoadedPlugin } from "./loader.ts";
export { PluginRegistry } from "./registry.ts";
export { PluginLifecycleManager } from "./lifecycle.ts";
export { createPluginContext, type SandboxDeps } from "./sandbox.ts";
