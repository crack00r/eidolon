/**
 * Cognitive state machine for the PEAR loop.
 *
 * Manages phase transitions through Perceive-Evaluate-Act-Reflect,
 * validating that transitions follow the allowed graph.
 */

import type { EidolonError, Result } from "@eidolon/protocol";
import { createError, Err, ErrorCode, Ok } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.js";

export type CognitivePhase =
  | "starting"
  | "perceiving"
  | "evaluating"
  | "acting"
  | "reflecting"
  | "resting"
  | "stopping";

export type ActionType = "respond" | "execute_task" | "learn" | "dream" | "self_improve" | "alert" | "rest";

export interface CognitiveState {
  readonly phase: CognitivePhase;
  readonly currentAction: ActionType | null;
  readonly lastTransitionAt: number;
  readonly cycleCount: number;
}

/**
 * Valid transitions map. Each key maps to the set of phases it can transition to.
 * Every phase can also transition to "stopping".
 */
const VALID_TRANSITIONS: ReadonlyMap<CognitivePhase, ReadonlySet<CognitivePhase>> = new Map([
  ["starting", new Set(["perceiving", "stopping"])],
  ["perceiving", new Set(["evaluating", "resting", "stopping"])],
  ["evaluating", new Set(["acting", "stopping"])],
  ["acting", new Set(["reflecting", "stopping"])],
  ["reflecting", new Set(["perceiving", "resting", "stopping"])],
  ["resting", new Set(["perceiving", "stopping"])],
  ["stopping", new Set<CognitivePhase>()],
]);

export class CognitiveStateMachine {
  private currentState: CognitiveState;
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
    this.currentState = {
      phase: "starting",
      currentAction: null,
      lastTransitionAt: Date.now(),
      cycleCount: 0,
    };
  }

  /** Get current state. */
  get state(): CognitiveState {
    return this.currentState;
  }

  /** Transition to a new phase. Validates the transition is legal. */
  transition(to: CognitivePhase): Result<CognitiveState, EidolonError> {
    if (!this.canTransition(to)) {
      return Err(createError(ErrorCode.INVALID_TRANSITION, `Invalid transition: ${this.currentState.phase} -> ${to}`));
    }

    const from = this.currentState.phase;
    this.currentState = {
      phase: to,
      currentAction: null,
      lastTransitionAt: Date.now(),
      cycleCount: this.currentState.cycleCount,
    };

    this.logger.debug("state-machine", `Transition: ${from} -> ${to}`, {
      cycleCount: this.currentState.cycleCount,
    });

    return Ok(this.currentState);
  }

  /** Set the current action (only valid in 'acting' phase). */
  setAction(action: ActionType): Result<void, EidolonError> {
    if (this.currentState.phase !== "acting") {
      return Err(
        createError(
          ErrorCode.INVALID_TRANSITION,
          `Cannot set action in phase: ${this.currentState.phase} (must be 'acting')`,
        ),
      );
    }

    this.currentState = {
      ...this.currentState,
      currentAction: action,
    };

    this.logger.debug("state-machine", `Action set: ${action}`);
    return Ok(undefined);
  }

  /** Clear the current action (only valid in 'reflecting' or 'resting' phase). */
  clearAction(): Result<void, EidolonError> {
    if (this.currentState.phase !== "reflecting" && this.currentState.phase !== "resting") {
      return Err(
        createError(
          ErrorCode.INVALID_TRANSITION,
          `Cannot clear action in phase: ${this.currentState.phase} (must be 'reflecting' or 'resting')`,
        ),
      );
    }

    this.currentState = {
      ...this.currentState,
      currentAction: null,
    };

    this.logger.debug("state-machine", "Action cleared");
    return Ok(undefined);
  }

  /** Increment cycle count (called after each full PEAR cycle). */
  completeCycle(): void {
    this.currentState = {
      ...this.currentState,
      cycleCount: this.currentState.cycleCount + 1,
    };

    this.logger.debug("state-machine", `Cycle ${this.currentState.cycleCount} completed`);
  }

  /** Check if a transition is valid. */
  canTransition(to: CognitivePhase): boolean {
    const allowed = VALID_TRANSITIONS.get(this.currentState.phase);
    return allowed?.has(to) ?? false;
  }
}
