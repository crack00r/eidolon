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
  LlamaCppProviderConfig,
} from "@eidolon/protocol";
import type { Logger } from "../logging/logger.ts";
import { LlamaCppChatResponseSchema, LlamaCppStreamChunkSchema } from "./schemas.ts";

export class LlamaCppProvider implements ILLMProvider {
  readonly type = "llamacpp" as const;
  readonly name = "llama.cpp (local)";

  private readonly baseUrl: string;

  constructor(
    private readonly config: LlamaCppProviderConfig,
    readonly _logger: Logger,
  ) {
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error(`Invalid port: ${config.port}. Must be an integer between 1 and 65535.`);
    }
    this.baseUrl = `http://127.0.0.1:${config.port}`;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(3000), redirect: "error" });
      return res.ok;
    } catch {
      // Intentional: network error means llama.cpp server is unreachable
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

  async complete(messages: readonly LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
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
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`llama.cpp chat failed (${res.status}): ${text}`);
    }

    const raw: unknown = await res.json();
    const parsed = LlamaCppChatResponseSchema.safeParse(raw);

    if (!parsed.success) {
      throw new Error(`llama.cpp chat response validation failed: ${parsed.error.message}`);
    }

    const data = parsed.data;
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

  async *stream(messages: readonly LLMMessage[], options?: LLMCompletionOptions): AsyncIterable<LLMStreamEvent> {
    const body = {
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 2048,
      stop: options?.stopSequences,
      stream: true,
      stream_options: { include_usage: true },
    };

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
      redirect: "error",
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
    let lineBuffer = "";
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const segments = lineBuffer.split("\n");
        // Keep the last segment as it may be incomplete
        lineBuffer = segments.pop() ?? "";

        const lines = segments.filter((l) => l.startsWith("data: "));

        for (const line of lines) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const raw: unknown = JSON.parse(data);
            // Track usage from the final chunk if present
            if (typeof raw === "object" && raw !== null && "usage" in raw) {
              const usage = (raw as Record<string, unknown>).usage;
              if (typeof usage === "object" && usage !== null) {
                const u = usage as Record<string, unknown>;
                if (typeof u.prompt_tokens === "number") inputTokens = u.prompt_tokens;
                if (typeof u.completion_tokens === "number") outputTokens = u.completion_tokens;
              }
            }
            const parsed = LlamaCppStreamChunkSchema.safeParse(raw);
            if (!parsed.success) {
              this._logger.warn("llamacpp", "Malformed streaming chunk, skipping", {
                error: parsed.error.message,
              });
              continue;
            }
            const delta = parsed.data.choices[0]?.delta.content;
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

    // Process any remaining data in the line buffer
    if (lineBuffer.trim()) {
      const remaining = lineBuffer.trim();
      if (remaining.startsWith("data: ") && remaining.slice(6).trim() !== "[DONE]") {
        try {
          const data = remaining.slice(6).trim();
          const raw: unknown = JSON.parse(data);
          if (typeof raw === "object" && raw !== null && "usage" in raw) {
            const usage = (raw as Record<string, unknown>).usage;
            if (typeof usage === "object" && usage !== null) {
              const u = usage as Record<string, unknown>;
              if (typeof u.prompt_tokens === "number") inputTokens = u.prompt_tokens;
              if (typeof u.completion_tokens === "number") outputTokens = u.completion_tokens;
            }
          }
          const parsed = LlamaCppStreamChunkSchema.safeParse(raw);
          if (parsed.success) {
            const delta = parsed.data.choices[0]?.delta.content;
            if (delta) {
              yield { type: "text", text: delta };
            }
          }
        } catch {
          // Skip malformed final SSE line
        }
      }
    }

    yield { type: "done", usage: { inputTokens, outputTokens } };
  }
}
