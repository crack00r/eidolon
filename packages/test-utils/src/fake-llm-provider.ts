/**
 * FakeLLMProvider -- test mock for ILLMProvider.
 *
 * Returns configurable responses without connecting to any real backend.
 */

import type {
  ILLMProvider,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMMessage,
  LLMProviderType,
  LLMStreamEvent,
} from "@eidolon/protocol";

export class FakeLLMProvider implements ILLMProvider {
  readonly type: LLMProviderType;
  readonly name: string;

  private available = true;
  private models: string[] = ["fake-model"];
  private completionResponse: LLMCompletionResult;
  private streamEvents: LLMStreamEvent[] = [];
  private callLog: Array<{ messages: readonly LLMMessage[]; options?: LLMCompletionOptions }> = [];

  constructor(type: LLMProviderType = "ollama", name = "Fake Provider") {
    this.type = type;
    this.name = name;
    this.completionResponse = {
      content: "Fake response",
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "fake-model",
      finishReason: "stop",
    };
  }

  static withResponse(content: string, type: LLMProviderType = "ollama"): FakeLLMProvider {
    const provider = new FakeLLMProvider(type);
    provider.completionResponse = {
      content,
      usage: { inputTokens: 10, outputTokens: content.length },
      model: "fake-model",
      finishReason: "stop",
    };
    return provider;
  }

  static unavailable(type: LLMProviderType = "ollama"): FakeLLMProvider {
    const provider = new FakeLLMProvider(type);
    provider.available = false;
    return provider;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  setModels(models: string[]): void {
    this.models = models;
  }

  setStreamEvents(events: LLMStreamEvent[]): void {
    this.streamEvents = events;
  }

  getCalls(): ReadonlyArray<{ messages: readonly LLMMessage[]; options?: LLMCompletionOptions }> {
    return this.callLog;
  }

  getCallCount(): number {
    return this.callLog.length;
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async listModels(): Promise<readonly string[]> {
    return this.models;
  }

  async complete(
    messages: readonly LLMMessage[],
    options?: LLMCompletionOptions,
  ): Promise<LLMCompletionResult> {
    this.callLog.push({ messages, options });
    return this.completionResponse;
  }

  async *stream(
    messages: readonly LLMMessage[],
    options?: LLMCompletionOptions,
  ): AsyncIterable<LLMStreamEvent> {
    this.callLog.push({ messages, options });
    if (this.streamEvents.length > 0) {
      for (const event of this.streamEvents) {
        yield event;
      }
    } else {
      yield { type: "text", text: this.completionResponse.content };
      yield { type: "done", usage: this.completionResponse.usage };
    }
  }
}
