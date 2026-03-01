# Memory Engine

## The Problem with Current Approaches

### OpenClaw's Approach
- `MEMORY.md`: A markdown file the agent is asked to write to. Often forgotten.
- `memory/YYYY-MM-DD.md`: Daily notes. Same problem -- the model may or may not write.
- Pre-compaction flush: When the context window is nearly full, a panic mechanism reminds the model to save memories. This is a last resort, not a strategy.
- Vector search over markdown files. Good for retrieval, but the data was never reliably stored in the first place.

### Why It Fails
The fundamental issue: **memory is an optional prompt to the model, not a system-level guarantee.** The model is told "please write important things down." Sometimes it does. Sometimes it doesn't. There is no mechanism to ensure that important information from conversations is captured.

## Eidolon's Memory Architecture

Memory in Eidolon operates on five layers, with automatic extraction as the foundation and biologically-inspired "dreaming" for consolidation.

```
┌──────────────────────────────────────────────────────────┐
│                    MEMORY ENGINE                          │
│                                                           │
│  WAKING PHASE (During conversation)                      │
│  ┌────────────────────────────────────────────────────┐  │
│  │ WORKING MEMORY (RAM)                               │  │
│  │ Active context of current conversation              │  │
│  │ → Auto-Extractor stores facts after EVERY turn     │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         ▼                                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │ SHORT-TERM MEMORY (SQLite)                         │  │
│  │ Tables: facts, decisions, episodes, todos           │  │
│  │ Auto-stored, searchable, TTL: 90 days              │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         │                                 │
│  DREAMING PHASE (Configurable schedule)                  │
│  ┌──────────────────────▼─────────────────────────────┐  │
│  │ PHASE 1: HOUSEKEEPING (Light Sleep)                │  │
│  │ • Remove duplicates                                │  │
│  │ • Resolve contradictions                           │  │
│  │ • Prune expired entries                            │  │
│  │ • Link related memories                            │  │
│  └──────────────────────┬─────────────────────────────┘  │
│  ┌──────────────────────▼─────────────────────────────┐  │
│  │ PHASE 2: ASSOCIATIVE DISCOVERY (REM Sleep)         │  │
│  │ • Find connections between memories                │  │
│  │ • Cluster analysis over embeddings                 │  │
│  │ • Surface non-obvious relationships                │  │
│  └──────────────────────┬─────────────────────────────┘  │
│  ┌──────────────────────▼─────────────────────────────┐  │
│  │ PHASE 3: SCHEMA ABSTRACTION (NREM Deep Sleep)      │  │
│  │ • Generalize from specific memories to rules       │  │
│  │ • Extract recurring patterns                       │  │
│  │ • Update skills and procedures                     │  │
│  └──────────────────────┬─────────────────────────────┘  │
│                         ▼                                 │
│  ┌────────────────────────────────────────────────────┐  │
│  │ LONG-TERM MEMORY (SQLite + Markdown export)        │  │
│  │ Consolidated facts, rules, skills                   │  │
│  │ Vector-indexed (sqlite-vec)                         │  │
│  │ Automatically injected into system prompt           │  │
│  └────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌────────────────────────────────────────────────────┐  │
│  │ PROCEDURAL MEMORY (skills/*.md)                    │  │
│  │ Learned procedures with usage stats                 │  │
│  │ Auto-retirement on non-use                          │  │
│  │ Version-tracked                                     │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

## Layer Details

### Layer 1: Working Memory (RAM)

- **Scope:** Current conversation context
- **Storage:** In-memory (not persisted directly)
- **Lifetime:** Duration of a conversation session
- **Purpose:** Provides immediate context for the current interaction
- **How it feeds the next layer:** After each conversation turn, the Auto-Extractor analyzes the messages and stores structured information in short-term memory.

### Layer 2: Short-Term Memory (SQLite)

- **Scope:** Recent facts, decisions, and events
- **Storage:** SQLite `memories` table with type = 'short_term'
- **Lifetime:** 90 days (configurable), then pruned or consolidated
- **Purpose:** Quick access to recent conversation outcomes
- **Automatic population:** The Memory Extractor runs after every conversation turn

**Memory types stored:**
| Type | Example | Auto-extracted? |
|---|---|---|
| `fact` | "Manuel prefers TypeScript" | Yes |
| `decision` | "We chose Tauri over Electron" | Yes |
| `preference` | "Manuel likes dark mode" | Yes |
| `todo` | "Need to set up GPU worker" | Yes |
| `episode` | "Had a long discussion about architecture" | Yes |
| `correction` | "Manuel corrected me about X" | Yes |

### Layer 3: Long-Term Memory (SQLite + Markdown)

- **Scope:** Consolidated, verified knowledge
- **Storage:** SQLite `memories` table with type = 'long_term' + exported to MEMORY.md
- **Lifetime:** Permanent (until explicitly revised by dreaming)
- **Purpose:** Core knowledge base, injected into every Claude Code session
- **Population:** Through dreaming consolidation from short-term memory

### Layer 4: Procedural Memory (Skills)

- **Scope:** How to do things
- **Storage:** `skills/*.md` files in the workspace
- **Lifetime:** Permanent, with usage tracking and auto-retirement
- **Purpose:** Reusable procedures the agent has learned
- **Example:** "How to check the status of the GPU worker"

### Layer 5: Episodic Memory (SQLite)

- **Scope:** Summaries of past interactions
- **Storage:** SQLite `memories` table with type = 'episode'
- **Lifetime:** 365 days (configurable)
- **Purpose:** "Last week Manuel and I discussed..." context
- **Population:** Auto-generated after each significant conversation

## Auto-Extractor

The key innovation. Runs automatically after every conversation turn, without relying on the LLM to voluntarily write memory.

### Strategy 1: Lightweight LLM Extraction

Use a fast, cheap model (Haiku or local) with a focused prompt:

```
Given this conversation turn, extract structured information:

USER: {user_message}
ASSISTANT: {assistant_response}

Extract as JSON:
{
  "facts": ["fact1", "fact2"],
  "decisions": ["decision1"],
  "preferences": ["preference1"],
  "todos": ["todo1"],
  "corrections": ["correction1"]
}

Only extract CLEAR, EXPLICIT information. Do not infer.
Return empty arrays if nothing notable was said.
```

**Cost:** ~200 tokens per extraction. At 50 interactions/day = ~$0.10/day with Haiku.

### Strategy 2: Rule-Based Extraction (Zero-Cost)

Pattern matching for common patterns, no LLM needed:

```typescript
const extractors = [
  // Explicit memory requests
  { pattern: /(?:remember|merke dir|merk dir)\s+(.+)/i, type: 'fact' },
  // Preferences
  { pattern: /(?:i prefer|ich bevorzuge|lieber)\s+(.+)/i, type: 'preference' },
  // Decisions
  { pattern: /(?:let's go with|wir nehmen|entschieden)\s+(.+)/i, type: 'decision' },
  // Corrections
  { pattern: /(?:actually|eigentlich|nein,)\s+(.+)/i, type: 'correction' },
  // Todos
  { pattern: /(?:TODO|todo|reminder|erinnere)\s*:?\s*(.+)/i, type: 'todo' },
];
```

### Strategy 3: Hybrid (Recommended)

1. First: Rule-based extraction (instant, free)
2. Then: LLM extraction for turns with significant content (detected by length, question marks, explicit markers)
3. Skip extraction entirely for short acknowledgments ("ok", "thanks", "understood")

## Dreaming System

Inspired by the [Wintermute project](https://github.com/overcuriousity/wintermute)'s biologically-inspired memory consolidation.

### When Dreaming Runs

```
Configuration:
  memory.dreaming:
    enabled: true
    schedule: "02:00"           # Start time (local timezone)
    maxDuration: 3600           # Max duration in seconds (1 hour)
    phases: ["housekeeping", "rem", "nrem"]
    maxTokens: 10000            # Budget per dreaming session
    triggerOnIdle: true         # Also trigger after 2h of no user activity
```

Dreaming runs as an action in the Cognitive Loop when:
1. The configured time window is active, OR
2. The system has been idle for 2+ hours (configurable)
3. The energy budget allows it

### Phase 1: Housekeeping (Light Sleep)

**Purpose:** Clean up the memory store. No LLM needed.

Operations:
1. **Duplicate detection:** Compute similarity between memories. If two memories have >95% cosine similarity, merge them (keep the newer one, increment confidence).
2. **Contradiction resolution:** Find memories that contradict each other (negative cosine similarity on key terms). Flag for LLM resolution in Phase 2.
3. **Expiry pruning:** Remove short-term memories past their TTL.
4. **Reference linking:** Update cross-references between related memories.

### Phase 2: Associative Discovery (REM Sleep)

**Purpose:** Find non-obvious connections. Uses LLM.

Process:
1. Take recent short-term memories (last 7 days)
2. For each memory, find the 5 most semantically similar memories from long-term storage
3. Ask Claude (cheap model) to identify connections:

```
Given these memories, find any non-obvious connections or insights:

Recent: "Manuel set up a Tailscale network connecting all devices"
Related: 
- "Windows PC has RTX 5080 GPU"
- "Ubuntu server runs the main daemon"
- "Manuel wants TTS on the GPU"

Connections found (if any):
```

4. Store discovered connections as new memories of type `association`

### Phase 3: Schema Abstraction (NREM Deep Sleep)

**Purpose:** Generalize from specific memories to rules and patterns. Uses LLM.

Process:
1. Cluster memories by topic (using embedding clusters)
2. For each cluster with 3+ memories, ask Claude to abstract a rule:

```
Given these specific memories about the same topic:
1. "Manuel corrected me that TypeScript is preferred over Python for the core"
2. "Manuel said 'language doesn't matter as long as it's cross-platform'"
3. "We decided on TypeScript + Bun for the core daemon"

Abstract a general rule or pattern:
→ "When choosing technology for Eidolon, cross-platform compatibility is the
   primary criterion. TypeScript is the default for core components."
```

3. Store abstractions as long-term memories with type `rule`
4. Update procedural memory (skills) if the abstraction describes a procedure

### Dreaming Output

After each dreaming session, produce a summary:

```markdown
# Dreaming Session 2026-03-01 02:15

## Housekeeping
- Merged 3 duplicate memories
- Pruned 12 expired short-term entries
- Flagged 1 contradiction for resolution

## Associations Found
- Connection: Tailscale network + GPU worker → GPU service accessible via Tailscale
- Connection: User timezone (Europe/Berlin) + active hours → adjust rest durations

## Rules Abstracted
- "Cross-platform is the primary criterion for technology choices"
- "When uncertain about user preference, ask before acting externally"

## Contradictions Resolved
- Old: "User prefers Python" → New: "User prefers TypeScript for core, Python for ML"
```

## Memory Injection

Before each Claude Code session, relevant memories are injected into the workspace:

### MEMORY.md (Top-K relevant long-term memories)

```markdown
# Memory Context

## User
- Name: Manuel
- Timezone: Europe/Berlin
- Language preference: German and English

## Preferences
- Prefers TypeScript for core components
- Values cross-platform compatibility
- Wants deep system access on all devices

## Active Context
- Currently building Eidolon (personal AI assistant)
- Has Ubuntu server, Windows PC (RTX 5080), MacBook, iPhone
- All devices connected via Tailscale

## Rules
- When uncertain about preferences, ask before acting externally
- Always create branches for code changes, never commit to main directly
```

### Semantic Retrieval

For each incoming message, the Memory Engine:
1. Computes an embedding of the message
2. Queries sqlite-vec for the top 10 most relevant memories
3. Formats them into MEMORY.md
4. Injects into the Claude Code workspace before the session starts

## Search API

```typescript
interface MemorySearchResult {
  id: string;
  type: string;
  content: string;
  score: number;        // Relevance score
  source: string;       // Where it came from
  created_at: string;
  meta: Record<string, unknown>;
}

// Hybrid search: vector similarity + BM25 keyword matching
async function searchMemory(
  query: string,
  options?: {
    types?: string[];      // Filter by memory type
    limit?: number;        // Max results (default: 10)
    minScore?: number;     // Minimum relevance score
    recency?: boolean;     // Apply temporal decay
  }
): Promise<MemorySearchResult[]>;
```

## Comparison

| Aspect | OpenClaw | Wintermute | Eidolon |
|---|---|---|---|
| Extraction | Model must volunteer | Not specified | Automatic after every turn |
| Storage | Markdown files | MEMORIES.txt + SQLite | SQLite (structured) + Markdown (export) |
| Consolidation | None (pre-compaction panic) | Nightly dreaming (3 phases) | Dreaming (3 phases) + continuous |
| Search | Vector + BM25 over markdown | Not specified | Vector + BM25 over SQLite |
| Deduplication | None | Housekeeping phase | Housekeeping phase |
| Contradiction resolution | None | Housekeeping phase | REM phase |
| Association discovery | None | REM phase | REM phase |
| Rule abstraction | None | NREM phase | NREM phase |
| Cost control | No budget | Not specified | Token budget per phase |
| Transparency | None | Dreaming reports | Dreaming journal + dashboard |
