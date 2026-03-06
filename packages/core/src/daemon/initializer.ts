/**
 * Module initialization steps for the daemon.
 *
 * buildCoreInitSteps() returns the ordered list of init steps (1-16g, 17b)
 * that initialize all core modules. Steps 17 (channels) and 18-21 (gateway)
 * are handled separately by channel-wiring.ts and gateway-wiring.ts.
 *
 * The actual step implementations are split across sub-modules to keep each
 * file under 300 lines:
 *   - init-foundation.ts  (steps 1-5b: Logger, Config, Secrets, DB, Audit)
 *   - init-services.ts    (steps 6-10c: Health, Metrics, Telemetry, EventBus, etc.)
 *   - init-memory.ts      (steps 11-14c: Embedding, Memory, Claude, Plugins, LLM)
 *   - init-loop.ts        (steps 15-17b: SessionSupervisor, CognitiveLoop, Digest)
 */

import { buildFoundationSteps } from "./init-foundation.ts";
import { buildLoopSteps } from "./init-loop.ts";
import { buildMemorySteps } from "./init-memory.ts";
import { buildServiceSteps } from "./init-services.ts";
import type { DaemonOptions, InitializedModules } from "./types.ts";

// ---------------------------------------------------------------------------
// Public: build the ordered list of core init steps
// ---------------------------------------------------------------------------

export function buildCoreInitSteps(
  modules: InitializedModules,
  options?: DaemonOptions,
): Array<{ name: string; fn: () => Promise<void> | void }> {
  return [
    ...buildFoundationSteps(modules, options),
    ...buildServiceSteps(modules, options),
    ...buildMemorySteps(modules),
    ...buildLoopSteps(modules),
  ];
}
