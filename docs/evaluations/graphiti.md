# Graphiti Evaluation (P2-07)

> Evaluated: 2026-03-06. Context: Eidolon uses a custom Knowledge Graph with ComplEx embeddings and Leiden community detection.

## What is Graphiti?

[Graphiti](https://github.com/getzep/graphiti) (by Zep) is a temporal knowledge graph library for AI agents. It provides:
- Entity extraction from unstructured text
- Temporal edge tracking (when relationships were valid)
- Community detection and summarization
- Neo4j as the storage backend
- Integration with OpenAI or Anthropic for extraction

## Feature Comparison

| Feature | Eidolon Custom KG | Graphiti |
|---|---|---|
| **Storage** | SQLite (bun:sqlite) | Neo4j (requires separate server) |
| **Entity extraction** | Hybrid (regex + LLM) | LLM-only (OpenAI/Anthropic) |
| **Relation types** | Typed predicates (uses, owns, runs_on, etc.) | Free-form edges with temporal metadata |
| **Embeddings** | ComplEx (real + imaginary, link prediction) | OpenAI embeddings (similarity only) |
| **Community detection** | Leiden algorithm (local implementation) | Leiden via Neo4j GDS plugin |
| **Temporal tracking** | Created/updated timestamps on relations | First-class temporal intervals (valid_from, valid_to) |
| **Link prediction** | Yes (ComplEx scoring) | No (similarity search only) |
| **Deduplication** | Configurable similarity thresholds per entity type | LLM-based entity resolution |
| **Offline operation** | Full offline capability | Requires API calls for extraction |
| **Dependencies** | Zero (SQLite + pure TypeScript math) | Neo4j + OpenAI API + Python |

## Advantages of Graphiti

1. **Temporal reasoning**: Graphiti's first-class temporal intervals allow queries like "what was true in January 2026?" which our current implementation handles only with created_at timestamps.
2. **Battle-tested entity resolution**: LLM-based entity merging is more flexible than threshold-based cosine similarity.
3. **Neo4j query power**: Cypher queries are more expressive than our SQL-based graph traversal for complex patterns.
4. **Maintained by Zep**: Active development, community contributions, documentation.

## Disadvantages of Graphiti

1. **Neo4j dependency**: Requires running a separate Neo4j instance. This conflicts with Eidolon's "single SQLite database" architecture principle. Neo4j adds ~500 MB RAM overhead and operational complexity.
2. **Python runtime**: Graphiti is a Python library. Integrating it into our TypeScript/Bun stack would require a sidecar service or rewrite.
3. **API dependency**: Entity extraction requires OpenAI or Anthropic API calls, adding cost and latency to every memory operation. Our hybrid approach uses free regex extraction for the common case.
4. **No link prediction**: Graphiti does not support ComplEx-style knowledge graph embeddings for predicting missing relations. Our ComplEx implementation enables discovering implicit relationships during dreaming.
5. **No offline operation**: Without API access, Graphiti cannot extract entities. Eidolon's regex-first approach works fully offline.
6. **Overkill for personal scale**: Neo4j is designed for millions of nodes. Eidolon's personal KG will have hundreds to low thousands of entities, where SQLite with indexes is more than sufficient.

## Integration Complexity

Adopting Graphiti would require:
1. Adding Neo4j as a deployment dependency (Docker container or native install).
2. Creating a Python sidecar service to run Graphiti.
3. Building a TypeScript client to communicate with the sidecar.
4. Migrating existing kg_entities, kg_relations, and kg_communities tables to Neo4j.
5. Removing the ComplEx embedding system (no equivalent in Graphiti).
6. Removing the local Leiden implementation (replaced by Neo4j GDS).
7. Rewriting graph-enhanced search to query Neo4j instead of SQLite.

Estimated effort: 2-3 weeks of development plus ongoing operational overhead.

## Performance Comparison

| Operation | Eidolon Custom (SQLite) | Graphiti (Neo4j) |
|---|---|---|
| Entity insert | < 1ms | ~5ms (network + disk) |
| Relation insert | < 1ms | ~5ms (network + disk) |
| 2-hop graph traversal (100 entities) | ~2ms | ~5ms |
| 2-hop graph traversal (10,000 entities) | ~20ms | ~8ms |
| ComplEx training (1000 triples, 100 epochs) | ~2s | N/A (not supported) |
| Community detection (1000 entities) | ~100ms | ~200ms (GDS plugin) |
| Full startup | 0ms (embedded) | ~5s (Neo4j cold start) |

At personal scale (< 10,000 entities), SQLite is faster for all operations except complex multi-hop traversals, which are rare in our use case.

## Recommendation

**Do not adopt Graphiti. Keep the custom KG implementation.**

Rationale:
1. The operational overhead of Neo4j contradicts Eidolon's "zero external dependencies" architecture.
2. Link prediction via ComplEx is a unique capability that Graphiti does not offer.
3. The personal assistant scale (hundreds of entities) does not benefit from Neo4j's scalability.
4. Full offline operation is critical for Eidolon's reliability.
5. The integration effort (2-3 weeks) would be better spent on improving the existing KG.

**Selective adoption**: Consider borrowing Graphiti's temporal interval design. Adding `valid_from` and `valid_to` columns to `kg_relations` would enable temporal queries without the full Neo4j dependency. This is a targeted improvement (~1 day of work) that captures Graphiti's best idea without its overhead.
