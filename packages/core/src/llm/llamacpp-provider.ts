/**
 * llama.cpp provider -- connects to llama-server (llama.cpp HTTP server).
 *
 * The provider assumes llama-server is running externally or managed by the
 * daemon.  It speaks the llama.cpp HTTP API (OpenAI-compatible /v1 routes).
 */

import type {
  ILLMProvider,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMMessage,
  LLMStreamEvent,
} from "@eidolon/protocol";
import type { LlamaCppProviderConfig } from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

interface LlamaCppChatResponse {
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
  model: string;
}

interface LlamaCppStreamChunk {
  choices: Array<{
    delta: { content?: string };
    finish_reason: string | null;
  }>;
}

export class LlamaCppProvider implements ILLMProvider {
  readonly type = "llamacpp" as const;
  readonly name = "llama.cpp (local)";

  private readonly baseUrl: string;

  constructor(
    private readonly config: LlamaCppProviderConfig,
    private readonly logger: Logger,
  ) {
    this.baseUrl = `http://127.0.0.1:${config.port}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<readonly string[]> {
    // llama.cpp serves a single model per instance
    if (this.config.modelPath) {
      return [this.config.modelPath.split("/").pop() ?? "local-model"];
    }
    return ["local-model"];
  }

  async complete(
    messages: readonly LLMMessage[],
    options?: LLMCompletionOptions,
  ): Promise<LLMCompletionResult> {
    const body = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
      stop: options?.stopSequences,
      stream: false,
    };

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`llama.cpp chat failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as LlamaCppChatResponse;
    const choice = data.choices[0];

    return {
      content: choice?.message.content ?? "",
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      model: data.model ?? "local-model",
      finishReason: "stop",
    };
  }

  async *stream(
    messages: readonly LLMMessage[],
    options?: LLMCompletionOptions,
  ): AsyncIterable<LLMStreamEvent> {
    const body = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
      stop: options?.stopSequences,
      stream: true,
    };

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      yield { type: "error", error: `llama.cpp streaming failed (${res.status})` };
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split("\n").filter((l) => l.startsWith("data: "));

        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const chunk = JSON.parse(data) as LlamaCppStreamChunk;
            const delta = chunk.choices[0]?.delta.content;
            if (delta) {
              yield { type: "text", text: delta };
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
