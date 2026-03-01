# Eidolon Planner Agent Memory

## Architecture Decisions
- Claude Code CLI as engine (managed subprocess, not custom runtime)
- IClaudeProcess abstraction for testability
- 3-database split: memory.db, operational.db, audit.db
- Event Bus persisted to SQLite for crash recovery
- ComplEx embeddings for Knowledge Graph (not TransE)
- multilingual-e5-small for embeddings (384-dim, German support)
- RRF fusion for hybrid search (BM25 + vector)

## Design References
- docs/design/ARCHITECTURE.md -- core architecture
- docs/design/COGNITIVE_LOOP.md -- main loop design
- docs/design/MEMORY_ENGINE.md -- memory system
- docs/design/CLAUDE_INTEGRATION.md -- Claude Code integration

## Codebase Structure
(Agent will map the codebase as it explores)
