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
import {
  OllamaChatResponseSchema,
  OllamaChatStreamChunkSchema,
  OllamaEmbeddingsResponseSchema,
  OllamaTagsResponseSchema,
} from "./schemas.ts";

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
      // Intentional: network error means Ollama server is unreachable
      return false;
    }
  }

  async listModels(): Promise<readonly string[]> {
    try {
      const res = await fetch(`${this.config.host}/api/tags`);
      if (!res.ok) return [];
      const raw: unknown = await res.json();
      const parsed = OllamaTagsResponseSchema.safeParse(raw);
      if (!parsed.success) {
        this._logger.warn("ollama", "Malformed /api/tags response", { error: parsed.error.message });
        return [];
      }
      return parsed.data.models.map((m) => m.name);
    } catch {
      // Intentional: network/parse error returns empty model list
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

    const raw: unknown = await res.json();
    const parsed = OllamaChatResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error(`Ollama chat response validation failed: ${parsed.error.message}`);
    }

    const data = parsed.data;

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
            const raw: unknown = JSON.parse(line);
            const parsed = OllamaChatStreamChunkSchema.safeParse(raw);
            if (!parsed.success) {
              this._logger.warn("ollama", "Malformed streaming chunk, skipping", {
                error: parsed.error.message,
              });
              continue;
            }
            const data = parsed.data;
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
      const raw: unknown = await res.json();
      const parsed = OllamaEmbeddingsResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`Ollama embeddings response validation failed: ${parsed.error.message}`);
      }
      results.push(new Float32Array(parsed.data.embedding));
    }

    return results;
  }
}
