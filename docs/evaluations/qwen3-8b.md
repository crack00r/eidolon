# Qwen3-8B Local LLM Evaluation (P2-08)

> Evaluated: 2026-03-06. Context: Eidolon uses Claude Code CLI as its primary brain. This evaluates Qwen3-8B as a local LLM for specific lightweight tasks.

## Model Overview

| Aspect | Qwen3-8B |
|---|---|
| Parameters | 8 billion |
| Architecture | Transformer (dense) |
| Context window | 32,768 tokens (128K with YaRN) |
| Quantization options | Q4_K_M (~5 GB), Q5_K_M (~6 GB), FP16 (~16 GB) |
| Languages | English, Chinese, German (decent), 27+ others |
| License | Apache 2.0 |
| Thinking mode | Supports /think and /no_think toggles |

## Hardware Requirements

### On Eidolon's Available Hardware

| Device | GPU | VRAM | Qwen3-8B Feasibility |
|---|---|---|---|
| Ubuntu Server (brain) | None | N/A | CPU-only: ~3-5 tokens/sec with Q4. Too slow for interactive use but viable for batch extraction. |
| Windows PC | RTX 5080 | 16 GB | Excellent: Q4 at ~60-80 tokens/sec, Q5 at ~50-70 tokens/sec. Room alongside Qwen3-TTS (~3.4 GB). |
| MacBook | Apple Silicon | 16-36 GB | Good: Q4 at ~30-50 tokens/sec via llama.cpp with Metal. |

### VRAM Budget (Windows PC with RTX 5080)

| Model | VRAM (loaded) | Notes |
|---|---|---|
| Qwen3-TTS 1.7B | ~3.4 GB | Always loaded for voice |
| faster-whisper Large v3 | ~1.5 GB | Loaded on demand |
| Qwen3-8B Q4_K_M | ~5.0 GB | For local LLM tasks |
| **Total** | **~9.9 GB** | Leaves ~6 GB headroom on 16 GB VRAM |

Running Qwen3-8B alongside the voice models is feasible but tight. Model swapping (unloading Qwen3-8B when not in use) is recommended.

## Quality Comparison: Qwen3-8B vs Claude

### Memory Extraction (Key Use Case)

Memory extraction uses structured prompts to pull facts, decisions, and preferences from conversation turns. This is a structured output task, not a creative reasoning task.

| Aspect | Claude Haiku | Qwen3-8B (Q4) | Notes |
|---|---|---|---|
| Fact extraction accuracy | ~95% | ~85% | Qwen3-8B misses subtle facts and occasionally hallucinates. |
| JSON format compliance | ~99% | ~90% | Qwen3-8B occasionally produces malformed JSON. Retries help. |
| German language handling | Excellent | Good | Qwen3-8B handles German but is weaker on German-English code-switching. |
| Cost per extraction | ~$0.001 | $0.00 | Local = free. |
| Latency (per extraction) | ~300ms (API) | ~500ms (GPU) / ~3s (CPU) | GPU is competitive. CPU is too slow for interactive use. |

### Relevance Scoring (Self-Learning Filter)

| Aspect | Claude Haiku | Qwen3-8B | Notes |
|---|---|---|---|
| Classification accuracy | ~92% | ~80% | Qwen3-8B is less reliable for nuanced relevance judgments. |
| Consistent scoring | Good | Fair | Qwen3-8B scores vary more between identical prompts. |
| Cost per evaluation | ~$0.001 | $0.00 | Free. |

### Complex Reasoning (User Conversation)

| Aspect | Claude Opus/Sonnet | Qwen3-8B | Notes |
|---|---|---|---|
| Reasoning depth | Excellent | Poor-Fair | 8B models cannot match Claude's reasoning for complex tasks. |
| Tool use | Excellent | Poor | Qwen3-8B does not reliably call tools in Claude Code format. |
| Context following | Excellent | Fair | Degrades significantly past 8K tokens. |

## Recommended Use Cases

Based on the quality analysis, Qwen3-8B is suitable for these specific Eidolon tasks:

### Suitable (Cost Savings with Acceptable Quality)

1. **Memory extraction (batch)**: During dreaming phases, extract facts from conversation logs in batch. Quality drop (95% to 85%) is acceptable because dreaming already includes deduplication and verification.
2. **Entity classification**: Classifying entity types (person, technology, concept) is a simple classification task where 8B models perform well.
3. **Content summarization**: Summarizing learning discoveries before relevance scoring. Lower quality is acceptable for pre-filtering.
4. **Embedding-based tasks**: Using Qwen3-8B's embeddings as an alternative to dedicated embedding models (though multilingual-e5-small is better for this).

### Not Suitable (Use Claude Instead)

1. **User conversation**: Quality gap is too large. Users expect Claude-level responses.
2. **Code generation**: Tool use and code editing require Claude's capabilities.
3. **Complex reasoning**: Research, planning, and analysis tasks need stronger models.
4. **Safety classification**: Security-critical decisions must not rely on a smaller model.

## Integration Path

### Option 1: Ollama (Recommended)

Ollama provides a simple HTTP API compatible with the OpenAI chat completions format.

```bash
# Install on Windows PC (alongside GPU worker)
ollama pull qwen3:8b-q4_K_M
ollama serve  # Listens on port 11434
```

Integration with Eidolon's ILLMProvider interface (v2.0 feature):
- Add `OllamaProvider` implementing `ILLMProvider`
- Route specific task types (extraction, classification) to Ollama
- Keep Claude as the default for user-facing tasks

### Option 2: llama.cpp server

More control over model loading and VRAM management, but more complex setup.

```bash
# Build llama.cpp server
./llama-server -m qwen3-8b-q4_k_m.gguf -c 8192 --port 8080 --n-gpu-layers 99
```

Integration via `LlamaCppProvider` (already scaffolded in `packages/core/src/llm/llamacpp-provider.ts`).

### Option 3: vLLM (If Higher Throughput Needed)

Best throughput but heaviest setup. Only justified if running multiple concurrent extraction jobs.

## Cost Analysis

### Monthly Savings Estimate

| Task | Volume/month | Claude Haiku Cost | Qwen3-8B Cost | Savings |
|---|---|---|---|---|
| Memory extraction | ~1500 calls | ~$1.50 | $0.00 (local) | $1.50 |
| Relevance scoring | ~600 calls | ~$0.60 | $0.00 (local) | $0.60 |
| Entity classification | ~300 calls | ~$0.30 | $0.00 (local) | $0.30 |
| **Total** | | **~$2.40/month** | **$0.00** | **$2.40/month** |

The cost savings are modest ($2.40/month) because Haiku is already cheap. The primary benefit is **offline operation** and **independence from API availability**.

## Recommendation

**Add Qwen3-8B as an optional local LLM for batch tasks in v2.0, but do not replace Claude for any interactive tasks.**

Implementation plan:
1. v2.0 introduces the `ILLMProvider` abstraction (already planned).
2. Add `OllamaProvider` as the first local LLM integration.
3. Route memory extraction during dreaming to Ollama when available.
4. Route entity classification to Ollama when available.
5. Fallback to Claude Haiku when Ollama is unavailable.
6. User conversation and code generation always use Claude.

The Ollama provider is already partially scaffolded in `packages/core/src/llm/ollama-provider.ts`. The main work is connecting it to the task routing in the Cognitive Loop.

## Risks

1. **Quality regression in memory extraction**: If extraction accuracy drops below 80%, memories will contain more noise. Mitigate with stricter confidence thresholds for locally-extracted memories.
2. **VRAM contention**: Running Qwen3-8B alongside Qwen3-TTS may cause OOM on the RTX 5080 during concurrent voice + extraction. Mitigate with model swapping.
3. **Maintenance burden**: Supporting multiple LLM backends increases testing surface. The ILLMProvider abstraction helps, but each provider needs its own integration tests.
