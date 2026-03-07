/**
 * Zod schemas for validating LLM provider API responses.
 *
 * External API responses are a system boundary -- we must validate
 * their shape before accessing properties to prevent crashes from
 * malformed or unexpected data.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Ollama response schemas
// ---------------------------------------------------------------------------

/** Schema for a single message in an Ollama chat response. */
export const OllamaChatMessageSchema = z.object({
  role: z.string(),
  content: z.string(),
});

/** Schema for Ollama /api/chat non-streaming response. */
export const OllamaChatResponseSchema = z.object({
  model: z.string(),
  message: OllamaChatMessageSchema,
  done: z.boolean(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

/** Schema for Ollama /api/chat streaming chunks. */
export const OllamaChatStreamChunkSchema = z.object({
  message: OllamaChatMessageSchema.optional(),
  done: z.boolean(),
  prompt_eval_count: z.number().optional(),
  eval_count: z.number().optional(),
});

/** Schema for Ollama /api/tags response. */
export const OllamaTagsResponseSchema = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      size: z.number(),
      digest: z.string(),
    }),
  ),
});

/** Schema for Ollama /api/embeddings response. */
export const OllamaEmbeddingsResponseSchema = z.object({
  embedding: z.array(z.number()),
});

// ---------------------------------------------------------------------------
// llama.cpp response schemas
// ---------------------------------------------------------------------------

/** Schema for a single choice in a llama.cpp chat completion response. */
export const LlamaCppChoiceSchema = z.object({
  message: z.object({
    role: z.string(),
    content: z.string(),
  }),
  finish_reason: z.string(),
});

/** Schema for llama.cpp /v1/chat/completions non-streaming response. */
export const LlamaCppChatResponseSchema = z.object({
  choices: z.array(LlamaCppChoiceSchema).min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
    })
    .optional(),
  model: z.string().optional(),
});

/** Schema for a streaming delta in a llama.cpp SSE chunk. */
export const LlamaCppStreamChunkSchema = z.object({
  choices: z.array(
    z.object({
      delta: z.object({
        content: z.string().optional(),
      }),
      finish_reason: z.string().nullable(),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type OllamaChatResponse = z.infer<typeof OllamaChatResponseSchema>;
export type OllamaChatStreamChunk = z.infer<typeof OllamaChatStreamChunkSchema>;
export type OllamaTagsResponse = z.infer<typeof OllamaTagsResponseSchema>;
export type OllamaEmbeddingsResponse = z.infer<typeof OllamaEmbeddingsResponseSchema>;
export type LlamaCppChatResponse = z.infer<typeof LlamaCppChatResponseSchema>;
export type LlamaCppStreamChunk = z.infer<typeof LlamaCppStreamChunkSchema>;
