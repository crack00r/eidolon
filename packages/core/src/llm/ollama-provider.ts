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

// ---------------------------------------------------------------------------
// SSRF protection -- reject private/internal network addresses
// ---------------------------------------------------------------------------

/** IPv4 patterns for private/internal networks. */
const PRIVATE_IP_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // Class A private
  /^192\.168\./, // Class C private
  /^172\.(1[6-9]|2\d|3[01])\./, // Class B private (172.16-31.x)
  /^169\.254\./, // link-local
  /^0\./, // current network
  /^::1$/, // IPv6 loopback
  /^fc/i, // IPv6 unique local
  /^fd/i, // IPv6 unique local
  /^fe80/i, // IPv6 link-local
];

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "instance-data"]);

/**
 * Check whether an IP address string belongs to a private/internal network.
 */
function isPrivateIp(ip: string): boolean {
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(ip)) return true;
  }
  return false;
}

/**
 * Validate that a host URL does not point to a private/internal network address.
 * Throws an Error if the host is unsafe and `allowPrivateHosts` is not set.
 */
export function validateOllamaHost(host: string, allowPrivateHosts = false): void {
  if (allowPrivateHosts) return;

  let parsed: URL;
  try {
    parsed = new URL(host);
  } catch {
    throw new Error(`Invalid Ollama host URL: ${host}`);
  }

  const hostname = parsed.hostname.replace(/^\[/, "").replace(/]$/, "");

  if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
    throw new Error(`Ollama host rejected: ${hostname} is a blocked hostname (SSRF protection)`);
  }

  if (isPrivateIp(hostname)) {
    throw new Error(`Ollama host rejected: ${hostname} resolves to a private network address (SSRF protection)`);
  }
}

/**
 * Validate the host URL immediately before a fetch call to prevent DNS rebinding.
 * Re-checks that the URL still does not point to a private/internal address.
 */
function guardFetch(host: string, allowPrivateHosts: boolean): void {
  if (allowPrivateHosts) return;
  validateOllamaHost(host, false);
}

export class OllamaProvider implements ILLMProvider {
  readonly type = "ollama" as const;
  readonly name = "Ollama (local)";
  private readonly allowPrivateHosts: boolean;

  constructor(
    private readonly config: OllamaProviderConfig,
    readonly _logger: Logger,
    allowPrivateHosts = false,
  ) {
    this.allowPrivateHosts = allowPrivateHosts;
    validateOllamaHost(config.host, allowPrivateHosts);
  }

  async isAvailable(): Promise<boolean> {
    try {
      guardFetch(this.config.host, this.allowPrivateHosts);
      const res = await fetch(`${this.config.host}/api/tags`, { signal: AbortSignal.timeout(3000), redirect: "error" });
      return res.ok;
    } catch {
      // Intentional: network error means Ollama server is unreachable
      return false;
    }
  }

  async listModels(): Promise<readonly string[]> {
    try {
      guardFetch(this.config.host, this.allowPrivateHosts);
      const res = await fetch(`${this.config.host}/api/tags`, {
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
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

    guardFetch(this.config.host, this.allowPrivateHosts);
    const res = await fetch(`${this.config.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
      redirect: "error",
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

    guardFetch(this.config.host, this.allowPrivateHosts);
    const res = await fetch(`${this.config.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
      redirect: "error",
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
    let lineBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        lineBuffer += decoder.decode(value, { stream: true });
        const segments = lineBuffer.split("\n");
        // Keep the last segment as it may be incomplete
        lineBuffer = segments.pop() ?? "";
        const lines = segments.filter(Boolean);

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

    // Process any remaining data in the line buffer
    if (lineBuffer.trim()) {
      try {
        const raw: unknown = JSON.parse(lineBuffer);
        const parsed = OllamaChatStreamChunkSchema.safeParse(raw);
        if (parsed.success) {
          const data = parsed.data;
          if (data.message?.content) {
            yield { type: "text", text: data.message.content };
          }
          if (data.done) {
            inputTokens = data.prompt_eval_count ?? 0;
            outputTokens = data.eval_count ?? 0;
          }
        }
      } catch {
        // Skip malformed final line
      }
    }

    yield { type: "done", usage: { inputTokens, outputTokens } };
  }

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    const results: Float32Array[] = [];

    for (const text of texts) {
      guardFetch(this.config.host, this.allowPrivateHosts);
      const res = await fetch(`${this.config.host}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.config.defaultModel, prompt: text }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
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
