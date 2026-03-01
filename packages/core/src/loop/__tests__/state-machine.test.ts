import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.js";
import { CognitiveStateMachine } from "../state-machine.js";

function createSilentLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => logger,
  };
  return logger;
}

describe("CognitiveStateMachine", () => {
  const logger = createSilentLogger();

  test("starts in starting phase", () => {
    const sm = new CognitiveStateMachine(logger);
    expect(sm.state.phase).toBe("starting");
    expect(sm.state.currentAction).toBeNull();
    expect(sm.state.cycleCount).toBe(0);
  });

  test("transitions starting -> perceiving", () => {
    const sm = new CognitiveStateMachine(logger);
    const result = sm.transition("perceiving");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.phase).toBe("perceiving");
    expect(sm.state.phase).toBe("perceiving");
  });

  test("rejects invalid transitions", () => {
    const sm = new CognitiveStateMachine(logger);

    // starting -> acting is not valid (must go through perceiving, evaluating)
    const result = sm.transition("acting");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_TRANSITION");
    expect(result.error.message).toContain("starting -> acting");

    // starting -> resting is not valid
    const result2 = sm.transition("resting");
    expect(result2.ok).toBe(false);

    // State should remain unchanged
    expect(sm.state.phase).toBe("starting");
  });

  test("setAction works in acting phase", () => {
    const sm = new CognitiveStateMachine(logger);

    // Walk through to acting phase
    sm.transition("perceiving");
    sm.transition("evaluating");
    sm.transition("acting");

    const result = sm.setAction("respond");
    expect(result.ok).toBe(true);
    expect(sm.state.currentAction).toBe("respond");

    // Cannot set action in non-acting phase
    sm.transition("reflecting");
    const badResult = sm.setAction("learn");
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) {
      expect(badResult.error.code).toBe("INVALID_TRANSITION");
    }
  });

  test("clearAction works in reflecting phase", () => {
    const sm = new CognitiveStateMachine(logger);

    sm.transition("perceiving");
    sm.transition("evaluating");
    sm.transition("acting");
    sm.setAction("respond");
    sm.transition("reflecting");

    const result = sm.clearAction();
    expect(result.ok).toBe(true);
    expect(sm.state.currentAction).toBeNull();

    // Cannot clear action in perceiving phase
    sm.transition("perceiving");
    const badResult = sm.clearAction();
    expect(badResult.ok).toBe(false);
  });

  test("completeCycle increments counter", () => {
    const sm = new CognitiveStateMachine(logger);
    expect(sm.state.cycleCount).toBe(0);

    sm.completeCycle();
    expect(sm.state.cycleCount).toBe(1);

    sm.completeCycle();
    expect(sm.state.cycleCount).toBe(2);

    sm.completeCycle();
    expect(sm.state.cycleCount).toBe(3);
  });

  test("any phase can transition to stopping", () => {
    const phases = ["starting", "perceiving", "evaluating", "acting", "reflecting", "resting"] as const;

    for (const phase of phases) {
      const sm = new CognitiveStateMachine(logger);

      // Walk to the target phase
      if (phase === "perceiving") sm.transition("perceiving");
      else if (phase === "evaluating") {
        sm.transition("perceiving");
        sm.transition("evaluating");
      } else if (phase === "acting") {
        sm.transition("perceiving");
        sm.transition("evaluating");
        sm.transition("acting");
      } else if (phase === "reflecting") {
        sm.transition("perceiving");
        sm.transition("evaluating");
        sm.transition("acting");
        sm.transition("reflecting");
      } else if (phase === "resting") {
        sm.transition("perceiving");
        sm.transition("evaluating");
        sm.transition("acting");
        sm.transition("reflecting");
        sm.transition("resting");
      }

      expect(sm.canTransition("stopping")).toBe(true);
      const result = sm.transition("stopping");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.phase).toBe("stopping");
      }
    }
  });

  test("full PEAR cycle works", () => {
    const sm = new CognitiveStateMachine(logger);

    // starting -> perceiving -> evaluating -> acting -> reflecting -> perceiving
    expect(sm.transition("perceiving").ok).toBe(true);
    expect(sm.transition("evaluating").ok).toBe(true);
    expect(sm.transition("acting").ok).toBe(true);
    expect(sm.setAction("respond").ok).toBe(true);
    expect(sm.transition("reflecting").ok).toBe(true);
    expect(sm.clearAction().ok).toBe(true);
    sm.completeCycle();
    expect(sm.state.cycleCount).toBe(1);

    // Another cycle
    expect(sm.transition("perceiving").ok).toBe(true);
    expect(sm.transition("evaluating").ok).toBe(true);
    expect(sm.transition("acting").ok).toBe(true);
    expect(sm.transition("reflecting").ok).toBe(true);
    expect(sm.transition("resting").ok).toBe(true);
    sm.completeCycle();
    expect(sm.state.cycleCount).toBe(2);

    // After resting, back to perceiving
    expect(sm.transition("perceiving").ok).toBe(true);
  });
});
