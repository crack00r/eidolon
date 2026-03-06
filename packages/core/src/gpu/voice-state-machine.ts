/**
 * Voice state machine with validated transitions, events, and barge-in handling.
 *
 * States: idle -> listening -> processing -> speaking -> interrupted
 * Transitions are validated; invalid transitions are rejected.
 */

import type { Logger } from "../logging/logger.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoiceMachineState = "idle" | "listening" | "processing" | "speaking" | "interrupted";

export type VoiceTransitionEvent =
  | "speech_start"
  | "speech_end"
  | "processing_complete"
  | "tts_started"
  | "tts_complete"
  | "barge_in"
  | "interrupt_handled"
  | "reset";

export interface VoiceStateTransition {
  readonly from: VoiceMachineState;
  readonly to: VoiceMachineState;
  readonly event: VoiceTransitionEvent;
  readonly timestamp: number;
}

/** Callback invoked on every valid state transition. */
export type StateChangeCallback = (transition: VoiceStateTransition) => void;

/** Callback invoked when barge-in occurs (cancel TTS, flush audio). */
export type BargeInCallback = () => void;

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * Allowed transitions defined as a map from (currentState, event) -> nextState.
 * Any transition not in this map is invalid and will be rejected.
 */
const TRANSITION_TABLE: ReadonlyMap<string, VoiceMachineState> = new Map([
  // idle transitions
  ["idle:speech_start", "listening"],
  ["idle:reset", "idle"],

  // listening transitions
  ["listening:speech_end", "processing"],
  ["listening:barge_in", "interrupted"],
  ["listening:reset", "idle"],

  // processing transitions
  ["processing:processing_complete", "idle"],
  ["processing:tts_started", "speaking"],
  ["processing:barge_in", "interrupted"],
  ["processing:reset", "idle"],

  // speaking transitions
  ["speaking:tts_complete", "idle"],
  ["speaking:barge_in", "interrupted"],
  ["speaking:reset", "idle"],

  // interrupted transitions
  ["interrupted:interrupt_handled", "listening"],
  ["interrupted:reset", "idle"],
]);

// ---------------------------------------------------------------------------
// VoiceStateMachine
// ---------------------------------------------------------------------------

export class VoiceStateMachine {
  private currentState: VoiceMachineState = "idle";
  private readonly logger: Logger;
  private readonly stateChangeCallbacks: StateChangeCallback[] = [];
  private readonly bargeInCallbacks: BargeInCallback[] = [];
  private readonly history: VoiceStateTransition[] = [];
  private readonly maxHistory: number;

  constructor(logger: Logger, maxHistory = 50) {
    this.logger = logger.child("voice-state-machine");
    this.maxHistory = maxHistory;
  }

  /** Get current state. */
  get state(): VoiceMachineState {
    return this.currentState;
  }

  /** Get transition history (most recent last). */
  getHistory(): readonly VoiceStateTransition[] {
    return this.history;
  }

  /**
   * Attempt a state transition via an event.
   * Returns true if the transition was valid and applied, false otherwise.
   */
  transition(event: VoiceTransitionEvent): boolean {
    const key = `${this.currentState}:${event}`;
    const nextState = TRANSITION_TABLE.get(key);

    if (nextState === undefined) {
      this.logger.warn("transition", `Invalid transition: ${key}`, {
        currentState: this.currentState,
        event,
      });
      return false;
    }

    const transitionRecord: VoiceStateTransition = {
      from: this.currentState,
      to: nextState,
      event,
      timestamp: Date.now(),
    };

    this.logger.debug("transition", `${this.currentState} -> ${nextState} (${event})`);
    this.currentState = nextState;

    // Track history
    this.history.push(transitionRecord);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    // Fire barge-in callbacks before state change callbacks
    if (event === "barge_in") {
      for (const cb of this.bargeInCallbacks) {
        try {
          cb();
        } catch (err: unknown) {
          this.logger.error("callback-error", "Barge-in callback threw", err);
        }
      }
    }

    // Fire state change callbacks
    for (const cb of this.stateChangeCallbacks) {
      try {
        cb(transitionRecord);
      } catch (err: unknown) {
        this.logger.error("callback-error", "State change callback threw", err);
      }
    }

    return true;
  }

  /**
   * Handle barge-in: transitions to interrupted state from listening, processing, or speaking.
   * Returns true if the barge-in was valid.
   */
  bargeIn(): boolean {
    return this.transition("barge_in");
  }

  /** Check whether a given event would be a valid transition from the current state. */
  canTransition(event: VoiceTransitionEvent): boolean {
    return TRANSITION_TABLE.has(`${this.currentState}:${event}`);
  }

  /** Register a callback for state changes. */
  onStateChange(callback: StateChangeCallback): void {
    this.stateChangeCallbacks.push(callback);
  }

  /** Register a callback for barge-in events (cancel TTS, flush audio). */
  onBargeIn(callback: BargeInCallback): void {
    this.bargeInCallbacks.push(callback);
  }

  /** Reset the machine to idle state. */
  reset(): void {
    this.transition("reset");
  }
}
