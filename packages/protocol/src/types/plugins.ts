/**
 * Plugin system types.
 *
 * Eidolon plugins are npm packages that extend functionality through a
 * well-defined interface with permission-gated access to core subsystems.
 */

// ---------------------------------------------------------------------------
// Plugin permissions -- what a plugin is allowed to do
// ---------------------------------------------------------------------------

export type PluginPermission =
  | "events:listen"
  | "events:emit"
  | "memory:read"
  | "memory:write"
  | "config:read"
  | "config:write"
  | "gateway:register"
  | "channel:register"
  | "shell:execute"
  | "filesystem:write";

// ---------------------------------------------------------------------------
// Extension points -- where a plugin can hook in
// ---------------------------------------------------------------------------

export type ExtensionPointType =
  | "channel"
  | "rpc-handler"
  | "event-listener"
  | "memory-extractor"
  | "cli-command"
  | "config-schema";

export interface ExtensionPoint {
  readonly type: ExtensionPointType;
  /** Human-readable name. */
  readonly name: string;
  /** Additional metadata for the extension point. */
  readonly config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Plugin manifest (from package.json "eidolon" field or eidolon-plugin.json)
// ---------------------------------------------------------------------------

export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly author?: string;
  /** Minimum compatible Eidolon core version. */
  readonly eidolonVersion: string;
  /** Permissions the plugin requires. */
  readonly permissions: readonly PluginPermission[];
  /** Extension points the plugin provides. */
  readonly extensionPoints: readonly ExtensionPoint[];
  /** Entry point relative to the package root. */
  readonly main: string;
}

// ---------------------------------------------------------------------------
// Plugin lifecycle states
// ---------------------------------------------------------------------------

export type PluginState =
  | "discovered"
  | "loaded"
  | "initialized"
  | "started"
  | "stopped"
  | "error";

// ---------------------------------------------------------------------------
// Runtime plugin info
// ---------------------------------------------------------------------------

export interface PluginInfo {
  readonly manifest: PluginManifest;
  readonly state: PluginState;
  readonly loadedAt?: number;
  readonly startedAt?: number;
  readonly error?: string;
  /** Directory the plugin was loaded from. */
  readonly directory: string;
}

// ---------------------------------------------------------------------------
// Plugin context -- sandboxed API surface provided to plugins at init
// ---------------------------------------------------------------------------

export interface PluginContext {
  readonly pluginName: string;
  readonly permissions: ReadonlySet<PluginPermission>;
  readonly log: PluginLogger;

  /**
   * Subscribe to EventBus events (requires "events:listen").
   * Returns an unsubscribe function.
   */
  onEvent(type: string, handler: (event: unknown) => void | Promise<void>): () => void;

  /** Emit an event (requires "events:emit"). */
  emitEvent(type: string, payload: unknown, priority?: string): void;

  /** Read configuration (requires "config:read"). */
  getConfig(): Record<string, unknown>;

  /** Register a gateway RPC handler (requires "gateway:register"). */
  registerRpcHandler(method: string, handler: (params: unknown) => Promise<unknown>): void;

  /** Register a channel (requires "channel:register"). */
  registerChannel(channel: unknown): void;
}

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Plugin interface -- what a plugin module must export
// ---------------------------------------------------------------------------

export interface EidolonPlugin {
  /** Called once when the plugin is initialized. */
  init(context: PluginContext): Promise<void> | void;
  /** Called when the daemon starts (after init). */
  start?(): Promise<void> | void;
  /** Called when the daemon stops (before destroy). */
  stop?(): Promise<void> | void;
  /** Called when the plugin is unloaded. */
  destroy?(): Promise<void> | void;
}
