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

## Graph Memory (Relationships Between Concepts)

Inspired by [Mem0](https://github.com/mem0ai/mem0)'s graph memory. Beyond flat facts, Eidolon tracks relationships between concepts.

```sql
CREATE TABLE memory_edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL REFERENCES memories(id),
    target_id TEXT NOT NULL REFERENCES memories(id),
    relation TEXT NOT NULL,        -- 'related_to', 'contradicts', 'refines', 'depends_on'
    strength REAL DEFAULT 1.0,     -- Decays over time, strengthened by re-discovery
    created_at TEXT NOT NULL,
    source_phase TEXT              -- 'extraction', 'rem_dreaming', 'manual'
);
```

### How Edges Are Created

1. **During extraction:** When a new fact relates to an existing one, an edge is created automatically.
   - "Manuel uses Tailscale" + "GPU worker connects via Tailscale" → `related_to` edge
2. **During REM dreaming:** The associative discovery phase explicitly searches for non-obvious connections and creates edges.
3. **During NREM dreaming:** Schema abstraction identifies dependencies and refinements.

### How Edges Are Used

Memory search uses edges to expand results: if a query matches "Tailscale", the graph walk also returns connected memories about GPU workers, network setup, and device connectivity -- even if those memories don't contain the word "Tailscale."

```typescript
async function searchWithGraph(query: string, depth: number = 1): Promise<MemorySearchResult[]> {
  // 1. Standard hybrid search (vector + BM25)
  const directMatches = await this.hybridSearch(query);
  
  // 2. Walk the graph from direct matches
  const expanded = new Set<string>();
  for (const match of directMatches.slice(0, 5)) {
    const neighbors = await this.getEdges(match.id, depth);
    neighbors.forEach(n => expanded.add(n.target_id));
  }
  
  // 3. Fetch and rank expanded results
  const graphMatches = await this.getMemories([...expanded]);
  
  // 4. Merge and re-rank (direct matches score higher)
  return this.mergeAndRank(directMatches, graphMatches);
}
```

## Knowledge Graph (Entity-Relation Model)

The graph memory edges above link existing memories. The Knowledge Graph goes further: it extracts **named entities** and **typed relations** (subject-predicate-object triples) from memories, stores them as first-class objects, and uses **TransE embeddings** for link prediction and analogical reasoning. Inspired by [Mem0](https://github.com/mem0ai/mem0)'s graph memory and academic knowledge graph embedding research.

### Why a Knowledge Graph?

Flat memories answer "what did we discuss?" Graph edges answer "what relates to what?" The Knowledge Graph answers **"how does the world work?"** — it captures structured knowledge about entities and their relationships that can be reasoned over, queried by traversal, and used for prediction.

Example: From conversations, the KG might learn:
- `(Manuel, owns, RTX 5080)` — extracted from "my RTX 5080"
- `(RTX 5080, has_vram, 16GB)` — extracted from specs discussion
- `(Qwen3-TTS, requires_vram, 3.4GB)` — extracted from GPU planning
- `(Qwen3-TTS, runs_on, RTX 5080)` — **predicted** by TransE from the above triples

### Schema

```sql
-- Named entities extracted from conversations and documents
CREATE TABLE kg_entities (
    id TEXT PRIMARY KEY,               -- nanoid
    name TEXT NOT NULL,                 -- "Manuel", "RTX 5080", "TypeScript"
    entity_type TEXT NOT NULL,          -- 'person', 'technology', 'device', 'project', 'concept', 'place'
    description TEXT,                   -- Brief description
    mention_count INTEGER DEFAULT 1,   -- How often this entity appears
    importance REAL DEFAULT 0.0,       -- PageRank score, updated during dreaming
    embedding BLOB,                    -- 384-dim float32 (from entity name + description)
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    meta TEXT                          -- JSON metadata
);

CREATE INDEX idx_kg_entities_type ON kg_entities(entity_type);
CREATE INDEX idx_kg_entities_name ON kg_entities(name);

-- Typed relations between entities (subject-predicate-object triples)
CREATE TABLE kg_relations (
    id TEXT PRIMARY KEY,               -- nanoid
    subject_id TEXT NOT NULL REFERENCES kg_entities(id),
    predicate TEXT NOT NULL,           -- 'uses', 'owns', 'runs_on', 'prefers', 'depends_on', etc.
    object_id TEXT NOT NULL REFERENCES kg_entities(id),
    confidence REAL DEFAULT 1.0,       -- 0.0 to 1.0
    source TEXT NOT NULL,              -- 'extraction', 'dreaming', 'prediction', 'manual'
    source_memory_id TEXT,             -- Which memory this was extracted from
    weight REAL DEFAULT 1.0,           -- Reinforced on re-discovery
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(subject_id, predicate, object_id)
);

CREATE INDEX idx_kg_relations_subject ON kg_relations(subject_id);
CREATE INDEX idx_kg_relations_object ON kg_relations(object_id);
CREATE INDEX idx_kg_relations_predicate ON kg_relations(predicate);

-- Community clusters of densely connected entities
CREATE TABLE kg_communities (
    id TEXT PRIMARY KEY,               -- nanoid
    name TEXT NOT NULL,                -- Auto-generated: "GPU & Voice Infrastructure"
    summary TEXT,                      -- LLM-generated summary of the community
    entity_ids TEXT NOT NULL,          -- JSON array of entity IDs in this community
    level INTEGER DEFAULT 0,           -- Hierarchy level (0 = leaf, higher = more abstract)
    parent_id TEXT REFERENCES kg_communities(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- TransE embeddings for entities and relations
CREATE TABLE kg_embeddings (
    id TEXT PRIMARY KEY,               -- entity_id or relation predicate
    type TEXT NOT NULL,                -- 'entity' or 'relation'
    embedding BLOB NOT NULL,           -- 128-dim float32 TransE embedding
    updated_at TEXT NOT NULL
);
```

### Entity & Relation Extraction

Entities and relations are extracted alongside regular memory extraction, using the same hybrid strategy:

**Rule-based extraction (zero-cost):**
```typescript
// Extract entities from structured patterns
const entityPatterns = [
  { pattern: /(?:using|mit|use)\s+([A-Z][\w.-]+)/g, type: 'technology' },
  { pattern: /(?:on|auf)\s+(RTX|GTX|GPU|CPU)\s*([\w\s]+)/gi, type: 'device' },
  { pattern: /(?:project|Projekt)\s+([A-Z][\w]+)/g, type: 'project' },
];

// Extract relations from verb patterns
const relationPatterns = [
  { pattern: /(\w+)\s+(?:uses|verwendet|nutzt)\s+(\w+)/i, predicate: 'uses' },
  { pattern: /(\w+)\s+(?:prefers|bevorzugt)\s+(\w+)/i, predicate: 'prefers' },
  { pattern: /(\w+)\s+(?:depends on|braucht|benötigt)\s+(\w+)/i, predicate: 'depends_on' },
  { pattern: /(\w+)\s+(?:runs on|läuft auf)\s+(\w+)/i, predicate: 'runs_on' },
];
```

**LLM-based extraction (for complex relations):**
```
Given this conversation turn, extract entities and relationships:

USER: {user_message}
ASSISTANT: {assistant_response}

Extract as JSON:
{
  "entities": [
    { "name": "...", "type": "person|technology|device|project|concept|place" }
  ],
  "relations": [
    { "subject": "...", "predicate": "...", "object": "..." }
  ]
}

Use specific predicates: uses, owns, runs_on, depends_on, prefers, creates,
is_part_of, located_in, has_property, related_to, contradicts, replaces.
```

Entity deduplication uses embedding similarity (>0.92 cosine → merge) plus exact name matching after normalization.

### TransE Embeddings

[TransE](https://papers.nips.cc/paper/5071-translating-embeddings-for-modeling-multi-relational-data) models relations as translations in embedding space: for a valid triple `(h, r, t)`, the relationship `h + r ≈ t` should hold.

**Training:** Runs during the REM dreaming phase on all current triples:

```typescript
// TransE scoring: lower distance = more likely true
function transEScore(h: Float32Array, r: Float32Array, t: Float32Array): number {
  let dist = 0;
  for (let i = 0; i < h.length; i++) {
    const diff = h[i] + r[i] - t[i];
    dist += diff * diff;
  }
  return Math.sqrt(dist);  // L2 distance; lower = better
}

// Training loop (margin-based ranking loss)
function trainTransE(
  triples: Triple[],
  entityEmbeddings: Map<string, Float32Array>,
  relationEmbeddings: Map<string, Float32Array>,
  epochs: number = 100,
  lr: number = 0.01,
  margin: number = 1.0,
  dim: number = 128
): void {
  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const { subject, predicate, object } of triples) {
      const h = entityEmbeddings.get(subject)!;
      const r = relationEmbeddings.get(predicate)!;
      const t = entityEmbeddings.get(object)!;

      // Corrupt either head or tail to create negative sample
      const corrupted = corruptTriple(subject, predicate, object, entityEmbeddings);
      const hNeg = entityEmbeddings.get(corrupted.subject)!;
      const tNeg = entityEmbeddings.get(corrupted.object)!;

      const posScore = transEScore(h, r, t);
      const negScore = transEScore(hNeg, r, tNeg);

      // Margin-based loss: push positive triples closer, negatives apart
      const loss = Math.max(0, margin + posScore - negScore);
      if (loss > 0) {
        // Gradient descent step on embeddings
        updateEmbeddings(h, r, t, hNeg, tNeg, lr);
      }
    }
  }
}
```

**Link prediction:** After training, predict missing relations:

```typescript
async function predictLinks(
  entity: string,
  predicates: string[],
  topK: number = 5
): Promise<PredictedTriple[]> {
  const h = await getTransEEmbedding(entity);
  const predictions: PredictedTriple[] = [];

  for (const predicate of predicates) {
    const r = await getTransEEmbedding(predicate);
    // h + r ≈ ? — find entities closest to (h + r)
    const target = add(h, r);
    const nearest = await findNearestEntities(target, topK);
    
    for (const { entityId, distance } of nearest) {
      // Skip if this triple already exists
      if (await tripleExists(entity, predicate, entityId)) continue;
      predictions.push({
        subject: entity,
        predicate,
        object: entityId,
        score: 1.0 / (1.0 + distance),  // Convert distance to 0-1 score
        source: 'prediction',
      });
    }
  }

  return predictions.sort((a, b) => b.score - a.score).slice(0, topK);
}
```

### Community Detection

During NREM dreaming, the Leiden algorithm groups densely connected entities into communities. This provides hierarchical understanding of the knowledge graph.

**Process:**
1. Build adjacency graph from `kg_relations`
2. Run Leiden algorithm (modularity optimization) to find communities
3. For each community, generate a summary using Claude (cheap model)
4. Store communities hierarchically (communities of communities)

```typescript
async function detectCommunities(): Promise<void> {
  // 1. Build adjacency from relations
  const edges = await db.all(`
    SELECT subject_id, object_id, weight
    FROM kg_relations WHERE confidence > 0.5
  `);

  // 2. Run Leiden algorithm (simplified: greedy modularity)
  const communities = leidenClustering(edges, { resolution: 1.0 });

  // 3. Summarize each community
  for (const community of communities) {
    const entities = await getEntities(community.memberIds);
    const relations = await getInternalRelations(community.memberIds);
    
    const summary = await cheapLLM(`
      These entities are closely related: ${entities.map(e => e.name).join(', ')}
      Relations: ${relations.map(r => `${r.subject} ${r.predicate} ${r.object}`).join('; ')}
      
      Generate a 1-sentence summary of what this cluster represents:
    `);

    await upsertCommunity({
      name: generateCommunityName(entities),
      summary,
      entityIds: community.memberIds,
      level: 0,
    });
  }
}
```

**Example communities:**
- **"Development Stack"**: TypeScript, Bun, SQLite, pnpm, Tauri → "Core technologies chosen for the Eidolon project, emphasizing cross-platform TypeScript."
- **"GPU Infrastructure"**: RTX 5080, Qwen3-TTS, Whisper, CUDA, Docker → "Hardware and software stack for GPU-accelerated voice processing."
- **"User Devices"**: MacBook, iPhone, Ubuntu Server, Windows PC, Tailscale → "Manuel's device mesh connected via Tailscale VPN."

### PageRank for Entity Importance

Entity importance is calculated using PageRank over the relation graph, updated during Housekeeping dreaming:

```sql
-- Simplified: count incoming relations, weighted by source importance
-- Full PageRank uses recursive CTEs in SQLite:
WITH RECURSIVE pagerank(entity_id, rank, iteration) AS (
  -- Base case: uniform distribution
  SELECT id, 1.0 / (SELECT COUNT(*) FROM kg_entities), 0
  FROM kg_entities
  UNION ALL
  -- Recursive step: sum incoming ranks / out-degree
  SELECT
    kr.object_id,
    0.15 / (SELECT COUNT(*) FROM kg_entities) +
    0.85 * SUM(pr.rank / NULLIF(
      (SELECT COUNT(*) FROM kg_relations WHERE subject_id = kr.subject_id), 0
    )),
    pr.iteration + 1
  FROM kg_relations kr
  JOIN pagerank pr ON kr.subject_id = pr.entity_id
  WHERE pr.iteration < 20  -- Max 20 iterations
  GROUP BY kr.object_id
)
SELECT entity_id, rank FROM pagerank
WHERE iteration = (SELECT MAX(iteration) FROM pagerank);
```

Entities with high PageRank (e.g., "TypeScript", "Eidolon", "Manuel") are prioritized in memory injection and search results.

### Graph-Enhanced Search

The Knowledge Graph enriches memory search by providing structured context:

```typescript
async function searchWithKnowledgeGraph(
  query: string,
  limit: number = 10
): Promise<EnrichedSearchResult[]> {
  // 1. Standard memory search (vector + BM25 + graph walk)
  const memories = await searchWithGraph(query, 1);

  // 2. Extract entities mentioned in the query
  const queryEntities = await extractEntities(query);

  // 3. Find related triples for each entity
  const relevantTriples: Triple[] = [];
  for (const entity of queryEntities) {
    const triples = await db.all(`
      SELECT e1.name as subject, r.predicate, e2.name as object
      FROM kg_relations r
      JOIN kg_entities e1 ON r.subject_id = e1.id
      JOIN kg_entities e2 ON r.object_id = e2.id
      WHERE r.subject_id = ? OR r.object_id = ?
      ORDER BY r.weight DESC
      LIMIT 10
    `, [entity.id, entity.id]);
    relevantTriples.push(...triples);
  }

  // 4. Find the community this query belongs to
  const community = await findRelevantCommunity(queryEntities);

  // 5. Inject structured context into results
  return {
    memories,
    knowledgeContext: {
      entities: queryEntities,
      triples: relevantTriples,
      community: community?.summary,
    },
  };
}
```

**Context injection into MEMORY.md:**
```markdown
## Knowledge Graph Context
- Manuel uses TypeScript (confidence: 0.95)
- Eidolon depends_on SQLite (confidence: 1.0)
- RTX 5080 has_property 16GB VRAM (confidence: 1.0)
- Qwen3-TTS runs_on RTX 5080 (confidence: 0.90)

## Related Cluster: "Development Stack"
Core technologies chosen for Eidolon: TypeScript, Bun, SQLite, pnpm.
Cross-platform compatibility is the primary criterion.
```

### Integration with Dreaming Phases

| Phase | KG Operations |
|---|---|
| **Housekeeping** | Merge duplicate entities (embedding similarity >0.92), update PageRank, prune orphaned entities with 0 relations |
| **REM** | Train TransE on all triples (100 epochs), predict new links (score >0.7 → add with source='prediction'), find cross-community connections |
| **NREM** | Run Leiden community detection, generate community summaries, create hierarchical community structure |

### Cost & Performance

- Entity/relation extraction adds ~100 tokens to the hybrid extraction prompt per turn
- TransE training on 1000 triples: <1 second (pure math, no LLM)
- Leiden community detection: <100ms for graphs with <10,000 edges
- Community summarization: ~200 tokens per community (cheap model)
- Total KG overhead during dreaming: ~2,000 tokens + <5 seconds compute

## Document Indexing

Beyond conversation memories, Eidolon can index personal documents for retrieval. Inspired by [Khoj](https://github.com/khoj-ai/khoj)'s "AI second brain" approach.

### Supported Document Types

| Type | Method | Chunking |
|---|---|---|
| Markdown (`.md`) | Direct text | By heading |
| Plain text (`.txt`) | Direct text | By paragraph |
| PDF | `pdf-parse` | By page |
| Code files | Tree-sitter AST | By function/class |

### Configuration

```jsonc
{
  "memory": {
    "indexing": {
      "enabled": true,
      "paths": [
        "~/Documents/notes/",
        "~/Projekte/eidolon/"
      ],
      "exclude": ["node_modules", ".git", "dist"],
      "fileTypes": [".md", ".txt", ".pdf", ".ts", ".py"],
      "recheckInterval": 3600,     // Re-index changed files every hour
      "maxFileSize": "1MB"
    }
  }
}
```

### How It Works

1. File watcher detects new/changed files in configured paths
2. Files are chunked according to their type
3. Each chunk gets an embedding and is stored in the `memories` table with `source: 'document'`
4. Document memories participate in the same search as conversation memories
5. During dreaming, document memories can form edges to conversation memories

This means when a user asks about a topic, Eidolon can reference both past conversations AND personal documents.

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
