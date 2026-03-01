/**
 * Dreaming subsystem -- orchestrates the three sleep phases.
 *
 * DreamRunner runs housekeeping, REM, and NREM in sequence,
 * respecting an optional time budget. Each phase produces a
 * DreamingResult conforming to the protocol type.
 */

import type { DreamingResult, EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../../logging/logger.js";
import type { HousekeepingPhase } from "./housekeeping.js";
import type { NremPhase } from "./nrem.js";
import type { RemPhase } from "./rem.js";

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type { HousekeepingResult } from "./housekeeping.js";
export { HousekeepingPhase, stringSimilarity } from "./housekeeping.js";
export type { AbstractRuleFn, NremResult } from "./nrem.js";
export { NremPhase } from "./nrem.js";
export type { AnalyzeConnectionsFn, RemResult } from "./rem.js";
export { RemPhase } from "./rem.js";
export type { DreamScheduleConfig } from "./scheduler.js";
export { DreamScheduler } from "./scheduler.js";

// ---------------------------------------------------------------------------
// DreamRunner
// ---------------------------------------------------------------------------

type PhaseType = "housekeeping" | "rem" | "nrem";

export class DreamRunner {
  private readonly housekeeping: HousekeepingPhase;
  private readonly rem: RemPhase;
  private readonly nrem: NremPhase;
  private readonly logger: Logger;

  constructor(housekeeping: HousekeepingPhase, rem: RemPhase, nrem: NremPhase, logger: Logger) {
    this.housekeeping = housekeeping;
    this.rem = rem;
    this.nrem = nrem;
    this.logger = logger.child("dream-runner");
  }

  /** Run all three dreaming phases in order. Respects optional time budget. */
  async runAll(options?: { maxDurationMs?: number }): Promise<Result<DreamingResult[], EidolonError>> {
    const results: DreamingResult[] = [];
    const startTime = Date.now();
    const maxDuration = options?.maxDurationMs;
    const phases: PhaseType[] = ["housekeeping", "rem", "nrem"];

    this.logger.info("runAll", "Starting dream cycle", { maxDurationMs: maxDuration });

    for (const phase of phases) {
      // Check time budget before starting the next phase
      if (maxDuration !== undefined) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= maxDuration) {
          this.logger.warn("runAll", `Time budget exhausted after ${elapsed}ms, skipping ${phase}`);
          break;
        }
      }

      const phaseResult = await this.runPhase(phase);
      if (!phaseResult.ok) {
        this.logger.error("runAll", `Phase ${phase} failed`, phaseResult.error);
        // Continue with next phase on failure (graceful degradation)
        continue;
      }

      results.push(phaseResult.value);
    }

    this.logger.info("runAll", "Dream cycle complete", {
      phasesCompleted: results.length,
      totalMs: Date.now() - startTime,
    });

    return Ok(results);
  }

  /** Run a single dreaming phase. */
  async runPhase(phase: PhaseType): Promise<Result<DreamingResult, EidolonError>> {
    const startedAt = Date.now();

    this.logger.info("runPhase", `Starting ${phase} phase`);

    try {
      switch (phase) {
        case "housekeeping": {
          const result = await this.housekeeping.run();
          if (!result.ok) return result;

          const hk = result.value;
          return Ok({
            phase: "housekeeping",
            startedAt,
            completedAt: Date.now(),
            memoriesProcessed: hk.duplicatesMerged + hk.expired + hk.contradictionsFound,
            memoriesCreated: 0,
            memoriesRemoved: hk.duplicatesMerged + hk.expired,
            edgesCreated: 0,
            tokensUsed: 0,
          });
        }

        case "rem": {
          const result = await this.rem.run();
          if (!result.ok) return result;

          const rem = result.value;
          return Ok({
            phase: "rem",
            startedAt,
            completedAt: Date.now(),
            memoriesProcessed: rem.associationsFound,
            memoriesCreated: 0,
            memoriesRemoved: 0,
            edgesCreated: rem.edgesCreated,
            tokensUsed: 0, // Will be non-zero once LLM is wired
          });
        }

        case "nrem": {
          const result = await this.nrem.run();
          if (!result.ok) return result;

          const nrem = result.value;
          return Ok({
            phase: "nrem",
            startedAt,
            completedAt: Date.now(),
            memoriesProcessed: nrem.memoriesPromoted,
            memoriesCreated: nrem.schemasCreated,
            memoriesRemoved: 0,
            edgesCreated: 0,
            tokensUsed: 0, // Will be non-zero once LLM is wired
          });
        }

        default: {
          return Err(createError(ErrorCode.DB_QUERY_FAILED, `Unknown dream phase: ${phase as string}`));
        }
      }
    } catch (cause) {
      return Err(createError(ErrorCode.DB_QUERY_FAILED, `Dream phase ${phase} failed`, cause));
    }
  }
}
