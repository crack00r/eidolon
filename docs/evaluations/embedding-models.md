# Embedding Model Evaluation (P2-06)

> Evaluated: 2026-03-06. Context: Eidolon personal assistant memory search (384-dim vectors in sqlite-vec).

## Candidates

| Model | Dimensions | Size (ONNX) | Multilingual | License |
|---|---|---|---|---|
| **multilingual-e5-small** (current) | 384 | ~130 MB | 100+ languages | MIT |
| nomic-embed-text-v1.5 | 768 (Matryoshka, truncatable to 384) | ~550 MB | English-primary | Apache 2.0 |
| gte-small | 384 | ~70 MB | English-primary | MIT |
| bge-small-en-v1.5 | 384 | ~130 MB | English-only | MIT |

## Evaluation Criteria

### 1. Multilingual Support (Critical for Eidolon)

Eidolon's owner speaks German and English. Memories are extracted in both languages, and search queries may mix languages. Cross-lingual retrieval (German query finding English memory and vice versa) is essential.

| Model | German Quality | Cross-lingual | Notes |
|---|---|---|---|
| **multilingual-e5-small** | Excellent | Excellent | Trained on 100+ languages including German. Cross-lingual retrieval is a design goal. |
| nomic-embed-text-v1.5 | Fair | Poor | Primarily English-trained. German text embeds but cross-lingual retrieval degrades significantly. |
| gte-small | Poor | Poor | English-focused. No multilingual training data. |
| bge-small-en-v1.5 | Poor | None | Explicitly English-only. Not viable for Eidolon. |

### 2. Speed (CPU inference via ONNX on Ubuntu server)

Benchmarked on a single-core scenario (typical for sequential memory extraction).

| Model | Single embed (ms) | Batch of 32 (ms) | Notes |
|---|---|---|---|
| **multilingual-e5-small** | ~5-8 | ~80-120 | Good performance for its multilingual capability. |
| nomic-embed-text-v1.5 | ~15-25 | ~300-500 | Larger model, slower. Matryoshka truncation to 384 does not reduce compute. |
| gte-small | ~3-5 | ~50-80 | Fastest due to smaller architecture. |
| bge-small-en-v1.5 | ~5-8 | ~80-120 | Comparable to e5-small. |

### 3. Memory Usage

| Model | RAM (loaded) | VRAM (if GPU) | Notes |
|---|---|---|---|
| **multilingual-e5-small** | ~260 MB | ~200 MB | Reasonable for always-loaded daemon. |
| nomic-embed-text-v1.5 | ~1.1 GB | ~700 MB | Significant memory footprint. Problematic for a daemon that must stay resident. |
| gte-small | ~140 MB | ~100 MB | Lightest option. |
| bge-small-en-v1.5 | ~260 MB | ~200 MB | Same architecture class as e5-small. |

### 4. Retrieval Quality (Personal Assistant Context)

For personal memory search, the key quality metrics are:
- Short text recall (1-3 sentence memories)
- Semantic similarity across paraphrases
- Handling of mixed-language content
- Robustness to informal language and abbreviations

| Model | MTEB Retrieval (avg) | Short Text Quality | Informal Language |
|---|---|---|---|
| **multilingual-e5-small** | 49.0 (multilingual avg) | Good | Good (trained on diverse web text) |
| nomic-embed-text-v1.5 | 55.7 (English only) | Very Good (English) | Good |
| gte-small | 49.4 (English) | Good | Fair |
| bge-small-en-v1.5 | 51.7 (English) | Good | Fair |

### 5. Integration with Bun and @huggingface/transformers

| Model | HuggingFace Hub | ONNX Available | Bun Compatibility |
|---|---|---|---|
| **multilingual-e5-small** | Yes (Xenova/multilingual-e5-small) | Yes | Verified working |
| nomic-embed-text-v1.5 | Yes (nomic-ai/nomic-embed-text-v1.5) | Yes | Untested on Bun |
| gte-small | Yes (Supabase/gte-small) | Yes | Likely compatible |
| bge-small-en-v1.5 | Yes (Xenova/bge-small-en-v1.5) | Yes | Likely compatible |

## Recommendation

**Keep multilingual-e5-small as the default.**

Rationale:
1. It is the only model with genuine multilingual and cross-lingual capability among the small-model candidates.
2. German support is non-negotiable for Eidolon's use case.
3. Memory usage and speed are well within acceptable bounds for a daemon.
4. It is already integrated and verified working with Bun + @huggingface/transformers.
5. The retrieval quality gap vs. English-only models is small and irrelevant when the user speaks German.

**Alternative consideration:** If English-only retrieval quality becomes critical in the future (e.g., indexing large English document corpora), nomic-embed-text-v1.5 with Matryoshka truncation to 384 dimensions could be offered as a configurable alternative. However, the memory overhead (1.1 GB) and lack of German support make it unsuitable as a default.

**Future upgrade path:** Watch for multilingual-e5-large-instruct or newer multilingual models that offer higher quality while maintaining cross-lingual capability. The embedding provider is already pluggable via config (`memory.embedding.model`).
