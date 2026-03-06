/**
 * Ollama provider -- connects to a local Ollama server for inference.
 *
 * Ollama exposes an HTTP API at localhost:11434 (or configured host).
 * See https://github.com/ollama/ollama/blob/main/docs/api.md
 */

import type {
  ILLMProvider,
  LLMCompletionOptions,
  LLMCompletionResult,
  LLMMessage,
  LLMStreamEvent,
  OllamaProviderConfig,
} from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaTagsResponse {
  models: Array<{ name: string; size: number; digest: string }>;
}

export class OllamaProvider implements ILLMProvider {
  readonly type = "ollama" as const;
  readonly name = "Ollama (local)";

  constructor(
    private readonly config: OllamaProviderConfig,
    readonly _logger: Logger,
  ) {}

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.config.host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<readonly string[]> {
    try {
      const res = await fetch(`${this.config.host}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as OllamaTagsResponse;
      return data.models.map((m) => m.name);
    } catch {
      return [];
    }
  }

  async complete(messages: readonly LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const model = options?.model ?? this.config.defaultModel;
    const body = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? 2048,
        stop: options?.stopSequences,
      },
    };

    const res = await fetch(`${this.config.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama chat failed (${res.status}): ${text}`);
    }

    const data = (await res.json()) as OllamaChatResponse;

    return {
      content: data.message.content,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
      },
      model: data.model,
      finishReason: "stop",
    };
  }

  async *stream(messages: readonly LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamEvent> {
    const model = options?.model ?? this.config.defaultModel;
    const body = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.maxTokens ?? 2048,
        stop: options?.stopSequences,
      },
    };

    const res = await fetch(`${this.config.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      yield { type: "error", error: `Ollama streaming failed (${res.status})` };
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      yield { type: "error", error: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split("\n").filter(Boolean);

        for (const line of lines) {
          try {
            const data = JSON.parse(line) as OllamaChatResponse;
            if (data.message?.content) {
              yield { type: "text", text: data.message.content };
            }
            if (data.done) {
              inputTokens = data.prompt_eval_count ?? 0;
              outputTokens = data.eval_count ?? 0;
            }
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", usage: { inputTokens, outputTokens } };
  }

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    const results: Float32Array[] = [];

    for (const text of texts) {
      const res = await fetch(`${this.config.host}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.config.defaultModel, prompt: text }),
      });

      if (!res.ok) throw new Error(`Ollama embeddings failed (${res.status})`);
      const data = (await res.json()) as { embedding: number[] };
      results.push(new Float32Array(data.embedding));
    }

    return results;
  }
}
