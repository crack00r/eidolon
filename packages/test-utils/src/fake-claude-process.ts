/**
 * FakeClaudeProcess -- test double implementing IClaudeProcess.
 * Records all calls and replays pre-configured response rules.
 */

import type {
  ClaudeSessionOptions,
  EidolonError,
  ErrorCode,
  IClaudeProcess,
  Result,
  StreamEvent,
} from "@eidolon/protocol";
import { createError, ErrorCode as EC, Err, Ok } from "@eidolon/protocol";

interface FakeCall {
  readonly prompt: string;
  readonly options: ClaudeSessionOptions;
}

interface ResponseRule {
  readonly matcher: RegExp | string;
  readonly events: readonly StreamEvent[];
}

export class FakeClaudeProcess implements IClaudeProcess {
  private readonly rules: ResponseRule[] = [];
  private readonly calls: FakeCall[] = [];
  private available = true;
  private version = "1.0.0";

  // ---------------------------------------------------------------------------
  // Factory methods for common test scenarios
  // ---------------------------------------------------------------------------

  /** Create a FakeClaudeProcess that responds with text for prompts matching the pattern. */
  static withResponse(matcher: RegExp | string, text: string): FakeClaudeProcess {
    const fake = new FakeClaudeProcess();
    fake.addRule(matcher, [
      { type: "text", content: text, timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);
    return fake;
  }

  /** Create a FakeClaudeProcess that simulates a tool use. */
  static withToolUse(tool: string, input: Record<string, unknown>, result: unknown): FakeClaudeProcess {
    const fake = new FakeClaudeProcess();
    fake.addRule(/./, [
      { type: "tool_use", toolName: tool, toolInput: input, timestamp: Date.now() },
      { type: "tool_result", toolResult: result, timestamp: Date.now() },
      { type: "done", timestamp: Date.now() },
    ]);
    return fake;
  }

  /** Create a FakeClaudeProcess that returns an error event. */
  static withError(_code: ErrorCode, message: string): FakeClaudeProcess {
    const fake = new FakeClaudeProcess();
    fake.addRule(/./, [{ type: "error", error: message, timestamp: Date.now() }]);
    return fake;
  }

  /** Create an unavailable FakeClaudeProcess (simulates Claude not installed). */
  static unavailable(): FakeClaudeProcess {
    const fake = new FakeClaudeProcess();
    fake.available = false;
    return fake;
  }

  // ---------------------------------------------------------------------------
  // Rule management
  // ---------------------------------------------------------------------------

  addRule(matcher: RegExp | string, events: readonly StreamEvent[]): void {
    this.rules.push({ matcher, events });
  }

  // ---------------------------------------------------------------------------
  // IClaudeProcess implementation
  // ---------------------------------------------------------------------------

  async *run(prompt: string, options: ClaudeSessionOptions): AsyncGenerator<StreamEvent> {
    this.calls.push({ prompt, options });

    const rule = this.rules.find((r) => {
      if (typeof r.matcher === "string") return prompt.includes(r.matcher);
      return r.matcher.test(prompt);
    });

    if (!rule) {
      yield { type: "text", content: `[FakeClaudeProcess] No rule for: ${prompt}`, timestamp: Date.now() };
      yield { type: "done", timestamp: Date.now() };
      return;
    }

    for (const event of rule.events) {
      yield event;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async getVersion(): Promise<Result<string, EidolonError>> {
    if (!this.available) {
      return Err(createError(EC.CLAUDE_NOT_INSTALLED, "Claude Code CLI not found"));
    }
    return Ok(this.version);
  }

  async abort(_sessionId: string): Promise<void> {
    // No-op for fake
  }

  // ---------------------------------------------------------------------------
  // Test assertion helpers
  // ---------------------------------------------------------------------------

  getCallCount(): number {
    return this.calls.length;
  }

  getLastPrompt(): string | undefined {
    return this.calls.at(-1)?.prompt;
  }

  getLastOptions(): ClaudeSessionOptions | undefined {
    return this.calls.at(-1)?.options;
  }

  getCalls(): readonly FakeCall[] {
    return this.calls;
  }

  reset(): void {
    this.calls.length = 0;
  }
}
