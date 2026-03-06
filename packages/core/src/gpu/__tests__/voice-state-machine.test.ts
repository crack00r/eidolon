import { describe, expect, test } from "bun:test";
import type { Logger } from "../../logging/logger.ts";
import type { VoiceStateTransition } from "../voice-state-machine.ts";
import { VoiceStateMachine } from "../voice-state-machine.ts";

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

const logger = createSilentLogger();

describe("VoiceStateMachine", () => {
  test("starts in idle state", () => {
    const sm = new VoiceStateMachine(logger);
    expect(sm.state).toBe("idle");
  });

  test("follows happy path: idle -> listening -> processing -> speaking -> idle", () => {
    const sm = new VoiceStateMachine(logger);

    expect(sm.transition("speech_start")).toBe(true);
    expect(sm.state).toBe("listening");

    expect(sm.transition("speech_end")).toBe(true);
    expect(sm.state).toBe("processing");

    expect(sm.transition("tts_started")).toBe(true);
    expect(sm.state).toBe("speaking");

    expect(sm.transition("tts_complete")).toBe(true);
    expect(sm.state).toBe("idle");
  });

  test("rejects invalid transitions", () => {
    const sm = new VoiceStateMachine(logger);

    // Cannot go from idle to processing directly
    expect(sm.transition("speech_end")).toBe(false);
    expect(sm.state).toBe("idle");

    // Cannot go from idle to speaking directly
    expect(sm.transition("tts_started")).toBe(false);
    expect(sm.state).toBe("idle");

    // Cannot go from idle to interrupted without barge_in
    expect(sm.transition("interrupt_handled")).toBe(false);
    expect(sm.state).toBe("idle");
  });

  test("barge-in from speaking state transitions to interrupted", () => {
    const sm = new VoiceStateMachine(logger);
    sm.transition("speech_start");
    sm.transition("speech_end");
    sm.transition("tts_started");
    expect(sm.state).toBe("speaking");

    expect(sm.bargeIn()).toBe(true);
    expect(sm.state).toBe("interrupted");

    // After interrupt handled, goes to listening
    expect(sm.transition("interrupt_handled")).toBe(true);
    expect(sm.state).toBe("listening");
  });

  test("barge-in fires barge-in callbacks", () => {
    const sm = new VoiceStateMachine(logger);
    let bargeInCalled = false;
    sm.onBargeIn(() => {
      bargeInCalled = true;
    });

    sm.transition("speech_start");
    sm.transition("speech_end");
    sm.transition("tts_started");

    sm.bargeIn();
    expect(bargeInCalled).toBe(true);
  });

  test("state change callback is fired on valid transitions", () => {
    const sm = new VoiceStateMachine(logger);
    const transitions: VoiceStateTransition[] = [];
    sm.onStateChange((t) => transitions.push(t));

    sm.transition("speech_start");
    sm.transition("speech_end");

    expect(transitions).toHaveLength(2);
    expect(transitions[0]?.from).toBe("idle");
    expect(transitions[0]?.to).toBe("listening");
    expect(transitions[0]?.event).toBe("speech_start");
    expect(transitions[1]?.from).toBe("listening");
    expect(transitions[1]?.to).toBe("processing");
  });

  test("canTransition returns correct values", () => {
    const sm = new VoiceStateMachine(logger);
    expect(sm.canTransition("speech_start")).toBe(true);
    expect(sm.canTransition("speech_end")).toBe(false);
    expect(sm.canTransition("tts_complete")).toBe(false);
    expect(sm.canTransition("reset")).toBe(true);
  });

  test("reset from any state goes to idle", () => {
    const sm = new VoiceStateMachine(logger);
    sm.transition("speech_start");
    sm.transition("speech_end");
    expect(sm.state).toBe("processing");

    sm.reset();
    expect(sm.state).toBe("idle");
  });

  test("history tracks transitions up to maxHistory", () => {
    const sm = new VoiceStateMachine(logger, 3);

    sm.transition("speech_start");
    sm.transition("speech_end");
    sm.transition("processing_complete");
    sm.transition("speech_start");

    const history = sm.getHistory();
    expect(history).toHaveLength(3);
    // First entry was shifted out
    expect(history[0]?.event).toBe("speech_end");
  });

  test("barge-in from processing state", () => {
    const sm = new VoiceStateMachine(logger);
    sm.transition("speech_start");
    sm.transition("speech_end");
    expect(sm.state).toBe("processing");

    expect(sm.bargeIn()).toBe(true);
    expect(sm.state).toBe("interrupted");
  });

  test("barge-in from idle state is rejected", () => {
    const sm = new VoiceStateMachine(logger);
    expect(sm.bargeIn()).toBe(false);
    expect(sm.state).toBe("idle");
  });
});
