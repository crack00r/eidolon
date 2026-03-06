/**
 * EidolonDaemon -- main daemon orchestrator.
 *
 * Thin class that composes initialization, channel wiring, gateway setup,
 * and shutdown from dedicated sub-modules. All heavy logic lives in:
 *   - initializer.ts    (steps 1-16g, 17b)
 *   - channel-wiring.ts (step 17 channels)
 *   - gateway-wiring.ts (steps 18-21)
 *   - shutdown.ts        (graceful shutdown + module teardown)
 *   - lifecycle.ts       (PID file, signal handlers, WAL checkpoints)
 *   - event-handlers.ts  (cognitive loop event routing)
 *   - types.ts           (DaemonOptions, InitializedModules)
 */

import { wireChannels } from "./channel-wiring.ts";
import { buildGatewayInitSteps } from "./gateway-wiring.ts";
import { buildCoreInitSteps } from "./initializer.ts";
import {
  type SignalHandlerState,
  registerSignalHandlers,
  removePidFile,
  removeSignalHandlers,
  writePidFile,
} from "./lifecycle.ts";
import { performShutdown, teardownModules } from "./shutdown.ts";
import type { DaemonOptions, InitializedModules } from "./types.ts";

export type { DaemonOptions } from "./types.ts";

// ---------------------------------------------------------------------------
// EidolonDaemon
// ---------------------------------------------------------------------------

export class EidolonDaemon {
  private _running = false;
  private readonly modules: InitializedModules = {};
  private readonly options: DaemonOptions;
  private shutdownPromise: Promise<void> | undefined;
  private readonly signalState: SignalHandlerState = { bound: false };

  constructor(options: DaemonOptions = {}) {
    this.options = options;
  }

  get isRunning(): boolean {
    return this._running;
  }

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    try {
      // Build the ordered list of init steps from all sources
      const initOrder: Array<{ name: string; fn: () => Promise<void> | void }> = [];

      // Steps 1-16g + 17b: core module initialization
      initOrder.push(...buildCoreInitSteps(this.modules, this.options));

      // Step 17: channel wiring (Telegram, Discord, WhatsApp, Email)
      initOrder.push({
        name: "ChannelWiring",
        fn: async () => {
          await wireChannels(this.modules);
        },
      });

      // Steps 18-21: gateway, GPU, discovery, auxiliary services
      initOrder.push(...buildGatewayInitSteps(this.modules));

      // Execute init steps in order
      for (const step of initOrder) {
        this.modules.logger?.debug("daemon", `Initializing ${step.name}...`);
        await step.fn();
      }

      // Write PID file
      writePidFile(this.modules.logger);

      // Register signal handlers
      registerSignalHandlers(
        this.signalState,
        this.modules.logger,
        () => this.stop(),
        () => this.shutdownPromise !== undefined,
      );

      this._running = true;
      this.modules.logger?.info("daemon", "Eidolon daemon started successfully");

      // Start the CognitiveLoop (PEAR cycle) in the background.
      // start() returns a promise that resolves when stop() is called.
      if (this.modules.cognitiveLoop) {
        this.modules.cognitiveLoop.start().catch((err: unknown) => {
          this.modules.logger?.error(
            "daemon",
            `CognitiveLoop crashed: ${err instanceof Error ? err.message : String(err)}`,
            err,
          );
        });
        this.modules.logger?.info("daemon", "CognitiveLoop started (PEAR cycle active)");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.modules.logger?.error("daemon", `Startup failed: ${message}`, err);

      // Teardown already-initialized modules in reverse
      await teardownModules(this.modules, this.modules.logger);
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  async stop(): Promise<void> {
    if (!this._running) return;

    // Prevent double-stop
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    const logger = this.modules.logger;
    const config = this.modules.config;
    const gracefulMs = config?.daemon.gracefulShutdownMs ?? 10_000;

    // Perform the multi-step shutdown sequence (steps 0a-6 + module teardown)
    await performShutdown(this.modules, gracefulMs, logger);

    // Remove PID file
    removePidFile(logger);

    // Remove signal handlers to prevent leaks on re-initialization
    removeSignalHandlers(this.signalState);

    this._running = false;
    logger?.info("daemon", "Eidolon daemon stopped");
  }
}
