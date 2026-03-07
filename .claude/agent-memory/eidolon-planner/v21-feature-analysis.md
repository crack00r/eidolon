# v2.1 Feature Analysis (March 2026)

## Recommended Priority Order
1. Tech debt (npm publish, flaky tests, oversized files, app tests) -- PREREQUISITE
2. MCP Tool Marketplace / Plugin Discovery (M effort, high impact)
3. Proactive Intelligence / Anticipatory Actions (L effort, high impact)
4. Kontextuelles Datei-/Projekt-Management (M effort, high impact)
5. Multi-User with Memory Isolation (XL effort, high impact)
6. Agentic Workflows / Multi-Step Tasks (L effort, high impact)
7. Structured Output / Reports (S effort, medium impact)
8. Conversation Branching (M effort, medium impact)
9. Secondary Node Replication (XL effort, medium impact)
10. Custom Model Fine-Tuning (XL effort, medium impact)
11. Spatial/Location Awareness (M effort, medium impact)

## Key Extension Points in Existing Code
- PluginContext.registerChannel() -- for new channels
- ExtensionPointType includes: channel, rpc-handler, event-listener, memory-extractor, cli-command, config-schema
- ILLMProvider with IModelRouter -- for task-based routing
- EventBus -- foundation for workflow orchestration
- SessionSupervisor -- manages concurrent sessions (main, learning, task, dream, voice)
- UserProfileGenerator in memory/profile.ts -- for proactive intelligence
- DocumentIndexer + DocumentWatcher -- for project management

## Eidolon's Three Key Differentiators (strengthen, don't dilute)
1. Dreaming/Consolidation (ComplEx KG + Louvain)
2. Self-Learning Pipeline (web crawling + safety classification)
3. Cognitive Loop as Daemon (PEAR cycle, continuous, not request-response)
